// Catch-up after a restart: a per-channel last-seen cursor on disk, a bounded
// fetch of what was posted since, and dedupe against live delivery. See DESIGN.md#replay
// Copied into iGio90/claude-builder image/bridge/ by its sync-replay.ts; edit it here.
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Client, Message } from 'discord.js'

const DISCORD_EPOCH = 1420070400000n
const CURSOR_TTL_MS = 7 * 24 * 60 * 60_000
const CLAIMED_CAP = 2048
const PAGE = 100

// maxCount: messages handed to the agent, after the gate; fetchCap: messages
// read per channel; holdMs: how long live messages wait for the replay;
// settleMs: how long cursor moves wait for replayed messages to be taken.
export type Bounds = { maxAgeMs: number; maxCount: number; fetchCap: number; holdMs: number; settleMs: number }
export const BOUNDS: Bounds = { maxAgeMs: 30 * 60_000, maxCount: 100, fetchCap: 500, holdMs: 30_000, settleMs: 10 * 60_000 }

export type Msg = { id: string; channelId: string }

// taken settles once the agent has the message, not just its queue.
export type Handed = { taken: Promise<void> }

export function snowflakeTime(id: string): number {
  return Number((BigInt(id) >> 22n) + DISCORD_EPOCH)
}

// The smallest id a message created at ms can have.
export function snowflakeAt(ms: number): string {
  const since = BigInt(Math.floor(ms)) - DISCORD_EPOCH
  return ((since > 0n ? since : 0n) << 22n).toString()
}

export function newer(a: string, b: string): boolean {
  return BigInt(a) > BigInt(b)
}

const SNOWFLAKE = /^\d{1,20}$/

// Last handled message id per channel or thread, in a JSON file.
export class Cursors {
  private ids: Record<string, string> = {}

  constructor(private readonly file: string, private readonly log: (msg: string) => void) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
      if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object')
      for (const [ch, id] of Object.entries(parsed as Record<string, unknown>)) {
        if (SNOWFLAKE.test(ch) && typeof id === 'string' && SNOWFLAKE.test(id)) this.ids[ch] = id
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log(`replay: ${file} unreadable (${err}); starting without last-seen state`)
    }
  }

  get(channelId: string): string | undefined {
    return this.ids[channelId]
  }

  channels(): string[] {
    return Object.keys(this.ids)
  }

  latest(): string | undefined {
    let max: string | undefined
    for (const id of Object.values(this.ids)) if (max === undefined || newer(id, max)) max = id
    return max
  }

  // Moves forward only; entries older than a week are pruned on write.
  advance(channelId: string, id: string, now = Date.now()): void {
    const cur = this.ids[channelId]
    if (cur !== undefined && !newer(id, cur)) return
    this.ids[channelId] = id
    for (const [ch, last] of Object.entries(this.ids)) {
      if (now - snowflakeTime(last) > CURSOR_TTL_MS) delete this.ids[ch]
    }
    const tmp = `${this.file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
      writeFileSync(tmp, JSON.stringify(this.ids) + '\n', { mode: 0o600 })
      renameSync(tmp, this.file)
    } catch (err) {
      rmSync(tmp, { force: true })
      this.log(`replay: cannot save ${this.file}: ${err}`)
    }
  }
}

// Missed messages in a channel are those after this id; null without saved state.
export function floor(cursors: Cursors, channelId: string, now: number, bounds: Bounds): string | null {
  const last = cursors.get(channelId) ?? cursors.latest()
  if (last === undefined) return null
  const oldest = snowflakeAt(now - bounds.maxAgeMs)
  return newer(last, oldest) ? last : oldest
}

// Every channel's floor as of now, so later cursor moves cannot shift them.
export function snapshotFloors(cursors: Cursors, now: number, bounds: Bounds): (channelId: string) => string | null {
  const fallback = floor(cursors, '', now, bounds)
  const floors = new Map(cursors.channels().map(ch => [ch, floor(cursors, ch, now, bounds)]))
  return ch => floors.get(ch) ?? fallback
}

// Unique by id, oldest first, the newest maxCount kept; the rest are dropped.
export function select<T extends { id: string }>(items: T[], maxCount: number): { keep: T[]; dropped: T[] } {
  const unique = [...new Map(items.map(m => [m.id, m])).values()]
  unique.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1))
  const cut = Math.max(0, unique.length - maxCount)
  return { keep: unique.slice(cut), dropped: unique.slice(0, cut) }
}

export type ReplayOptions<M extends Msg> = {
  cursors: Cursors
  // The live path; late: held while the replay ran. null: the gate dropped it.
  handle: (m: M, late: boolean) => Promise<Handed | null>
  // Judges a missed message as the live path would; the thunk delivers it.
  prepare: (m: M) => Promise<(() => Promise<Handed>) | null>
  // Whether the message's channel keeps a cursor (an access group, its threads, an allowed DM).
  inScope: (m: M) => boolean
  log: (msg: string) => void
  bounds?: Bounds
}

// Single entry for live and replayed messages: each id is handled once, and a
// cursor advances only once the agent has the message (or the gate dropped it).
export class Replay<M extends Msg> {
  private held: M[] | null = []
  private claimed = new Set<string>()
  private readonly bounds: Bounds
  // While the scan runs every cursor move waits; then only those of a channel
  // whose replays are not all taken, or one failed. See DESIGN.md#replay
  private scanning = false
  private waiting = new Map<string, number>()
  private failed = new Set<string>()
  private deferred = new Map<string, string>()
  // Per channel, the newest message read, reached once its replays settle.
  private reached = new Map<string, string>()
  private onSettled: () => void = () => {}

  constructor(private readonly o: ReplayOptions<M>) {
    this.bounds = o.bounds ?? BOUNDS
  }

  // Channels with a saved cursor, scanned besides the access groups.
  knownChannels(): string[] {
    return this.o.cursors.channels()
  }

  // A live message: held while the replay runs, then handled in arrival order.
  live(m: M): void {
    if (this.held) this.held.push(m)
    else void this.dispatch(m, false)
  }

  private claim(id: string): boolean {
    if (this.claimed.has(id)) return false
    this.claimed.add(id)
    if (this.claimed.size > CLAIMED_CAP) this.claimed.delete(this.claimed.values().next().value!)
    return true
  }

  private advance(m: M): void {
    if (!this.o.inScope(m)) return
    if (!this.scanning && !this.waiting.has(m.channelId) && !this.failed.has(m.channelId)) {
      this.o.cursors.advance(m.channelId, m.id)
      return
    }
    this.defer(m.channelId, m.id)
  }

  private defer(channelId: string, id: string): void {
    const cur = this.deferred.get(channelId)
    if (cur === undefined || newer(id, cur)) this.deferred.set(channelId, id)
  }

  // Moves the channel to what its replay read and what live delivery deferred.
  private release(channelId: string): void {
    for (const pending of [this.reached, this.deferred]) {
      const id = pending.get(channelId)
      pending.delete(channelId)
      if (id !== undefined) this.o.cursors.advance(channelId, id)
    }
  }

  // One replayed message of the channel was taken (ok) or failed; a failed
  // one keeps its channel's cursor before it until the settle bound.
  private settle(channelId: string, ok: boolean): void {
    if (!ok && this.waiting.has(channelId)) this.failed.add(channelId)
    const left = (this.waiting.get(channelId) ?? 0) - 1
    if (left > 0) {
      this.waiting.set(channelId, left)
      return
    }
    if (!this.waiting.delete(channelId)) return
    if (!this.scanning && !this.failed.has(channelId)) this.release(channelId)
    this.checkSettled()
  }

  private checkSettled(): void {
    if (!this.scanning && this.waiting.size === 0) this.onSettled()
  }

  private async dispatch(m: M, late: boolean): Promise<void> {
    if (!this.claim(m.id)) return
    try {
      const handed = await this.o.handle(m, late)
      if (handed) await handed.taken
      this.advance(m)
    } catch (err) {
      this.o.log(`replay: message ${m.id} in ${m.channelId} not delivered: ${err}`)
    }
  }

  // Fetches, judges and delivers the missed messages, then releases the held
  // live ones; those wait at most holdMs. Resolves once every replayed message
  // settled. After settleMs every held cursor move is forced through.
  async run(fetch: (floorOf: (channelId: string) => string | null) => Promise<M[]>, now = Date.now()): Promise<void> {
    this.scanning = true
    const settled = new Promise<void>(r => { this.onSettled = r })
    const bound = setTimeout(() => {
      const unsettled = [...new Set([...this.waiting.keys(), ...this.failed])]
      this.o.log(`replay: ${this.bounds.settleMs} ms bound reached; forcing every cursor forward${unsettled.length > 0 ? `; replayed messages not taken in ${unsettled.join(', ')} are skipped` : ''}`)
      this.scanning = false
      for (const ch of new Set([...unsettled, ...this.reached.keys(), ...this.deferred.keys()])) this.release(ch)
      this.waiting.clear()
      this.failed.clear()
      this.onSettled()
    }, this.bounds.settleMs)
    ;(bound as { unref?: () => void }).unref?.()
    const floorOf = snapshotFloors(this.o.cursors, now, this.bounds)
    const work = this.catchUp(fetch, floorOf, now)
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<'timeout'>(r => { timer = setTimeout(() => r('timeout'), this.bounds.holdMs) })
    if ((await Promise.race([work, timeout])) === 'timeout') {
      this.o.log(`replay: still running after ${this.bounds.holdMs} ms; releasing live messages`)
    }
    clearTimeout(timer)
    const held = this.held ?? []
    this.held = null
    for (const m of held) void this.dispatch(m, true)
    await work
    this.scanning = false
    for (const ch of new Set([...this.reached.keys(), ...this.deferred.keys()])) {
      if (!this.waiting.has(ch) && !this.failed.has(ch)) this.release(ch)
    }
    this.checkSettled()
    await settled
    if (this.failed.size === 0) clearTimeout(bound)
  }

  // Resolves once the deliveries are handed over; each settles on its own.
  private async catchUp(fetch: (floorOf: (channelId: string) => string | null) => Promise<M[]>, floorOf: (channelId: string) => string | null, now: number): Promise<void> {
    try {
      const latest = this.o.cursors.latest()
      if (latest === undefined) {
        this.o.log('replay: no last-seen state yet; nothing to replay')
        return
      }
      const oldest = now - this.bounds.maxAgeMs
      if (snowflakeTime(latest) < oldest) {
        this.o.log(`replay: last message seen at ${new Date(snowflakeTime(latest)).toISOString()}; messages before ${new Date(oldest).toISOString()} are not replayed`)
      }
      const fetched = select(await fetch(floorOf), Number.MAX_SAFE_INTEGER).keep
      const byChannel = new Map<string, M[]>()
      for (const m of fetched) {
        byChannel.set(m.channelId, [...(byChannel.get(m.channelId) ?? []), m])
        if (this.o.inScope(m)) this.reached.set(m.channelId, m.id)
      }
      const judged: { id: string; m: M; deliver: () => Promise<Handed> }[] = []
      await Promise.all([...byChannel.values()].map(async msgs => {
        for (const m of msgs) {
          if (!this.claim(m.id)) continue
          try {
            const deliver = await this.o.prepare(m)
            if (deliver) judged.push({ id: m.id, m, deliver })
          } catch (err) {
            this.o.log(`replay: message ${m.id} in ${m.channelId} not judged: ${err}`)
          }
        }
      }))
      const { keep, dropped } = select(judged, this.bounds.maxCount)
      if (dropped.length > 0) {
        this.o.log(`replay: ${dropped.length} older message(s) over the ${this.bounds.maxCount} cap not replayed: ${dropped[0]!.id}..${dropped.at(-1)!.id}`)
      }
      this.o.log(`replay: ${fetched.length} missed message(s), ${keep.length} for the agent`)
      for (const k of keep) this.waiting.set(k.m.channelId, (this.waiting.get(k.m.channelId) ?? 0) + 1)
      for (const k of keep) {
        const ch = k.m.channelId
        try {
          const handed = await k.deliver()
          void handed.taken.then(
            () => { this.defer(ch, k.id); this.settle(ch, true) },
            err => { this.o.log(`replay: message ${k.id} in ${ch} not taken: ${err}`); this.settle(ch, false) },
          )
        } catch (err) {
          this.o.log(`replay: message ${k.id} in ${ch} not delivered: ${err}`)
          this.settle(ch, false)
        }
      }
    } catch (err) {
      this.o.log(`replay failed: ${err}`)
    }
  }
}

export type Scope = {
  // Channel ids from access.json groups.
  groups: string[]
  ignored: (channelId: string, parentId: string | null) => boolean
  // Channels with a saved cursor, such as DMs and archived threads.
  known: string[]
  log: (msg: string) => void
}

type History = { id: string; isThread(): boolean; parentId?: string | null; messages: { fetch(o: { limit: number; before?: string }): Promise<Map<string, Message>> } }
type ActiveThreads = { fetchActiveThreads(): Promise<{ threads: ReadonlyMap<string, unknown> }> }

function hasHistory(ch: unknown): ch is History {
  return typeof ch === 'object' && ch !== null && 'messages' in ch && typeof (ch as { isThread?: unknown }).isThread === 'function'
}

// The group channels, their active threads (one call per guild) and the known
// channels, minus the ignored ones.
async function scopeChannels(client: Client, scope: Scope): Promise<History[]> {
  const out = new Map<string, History>()
  const guilds = new Map<string, ActiveThreads>()
  const add = (ch: unknown) => {
    if (!hasHistory(ch) || out.has(ch.id)) return
    if (scope.ignored(ch.id, ch.isThread() ? ch.parentId ?? null : null)) return
    out.set(ch.id, ch)
  }
  const fetchChannel = (id: string) => client.channels.fetch(id).catch((err: unknown) => {
    scope.log(`replay: channel ${id} unavailable: ${err}`)
    return null
  })
  for (const id of scope.groups) {
    if (scope.ignored(id, null)) continue
    const ch = await fetchChannel(id)
    add(ch)
    const guild = (ch as { guild?: { id: string; channels: ActiveThreads } } | null)?.guild
    if (guild) guilds.set(guild.id, guild.channels)
  }
  for (const [id, channels] of guilds) {
    try {
      const active = await channels.fetchActiveThreads()
      for (const t of active.threads.values()) {
        const parentId = (t as { parentId?: string | null }).parentId
        if (parentId && scope.groups.includes(parentId)) add(t)
      }
    } catch (err) {
      scope.log(`replay: active threads of guild ${id} unavailable: ${err}`)
    }
  }
  for (const id of scope.known) {
    if (out.has(id) || scope.ignored(id, null)) continue
    add(await fetchChannel(id))
  }
  return [...out.values()]
}

// Per channel, the newest messages after its floor, at most fetchCap, not the bot's own.
export async function fetchMissed(client: Client, scope: Scope, floorOf: (channelId: string) => string | null, fetchCap = BOUNDS.fetchCap): Promise<Message[]> {
  const out: Message[] = []
  for (const ch of await scopeChannels(client, scope)) {
    const after = floorOf(ch.id)
    if (after === null) continue
    let before: string | undefined
    let taken = 0
    let capped = false
    while (!capped) {
      let batch: Map<string, Message>
      try {
        batch = await ch.messages.fetch({ limit: PAGE, ...(before ? { before } : {}) })
      } catch (err) {
        scope.log(`replay: history of ${ch.id} unavailable: ${err}`)
        break
      }
      let reached = batch.size < PAGE
      for (const m of batch.values()) {
        if (!newer(m.id, after)) { reached = true; continue }
        if (before === undefined || newer(before, m.id)) before = m.id
        if (m.author.id === client.user?.id) continue
        if (taken >= fetchCap) { capped = true; break }
        out.push(m)
        taken++
      }
      if (reached) break
    }
    if (capped) scope.log(`replay: over ${fetchCap} messages missed in ${ch.id}; older ones not read`)
  }
  return out
}
