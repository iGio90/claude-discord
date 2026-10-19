// Catch-up after a restart: a per-channel last-seen cursor on disk, a bounded
// fetch of what was posted since, and dedupe against live delivery. See DESIGN.md#replay
// Twin of iGio90/claude-builder image/bridge/replay.ts: keep both identical but for this line.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Client, Message } from 'discord.js'

const DISCORD_EPOCH = 1420070400000n
const CURSOR_TTL_MS = 7 * 24 * 60 * 60_000
const CLAIMED_CAP = 2048
const PAGE = 100

export type Bounds = { maxAgeMs: number; maxCount: number; holdMs: number }
// holdMs: how long live messages wait for the replay before they go out anyway.
export const BOUNDS: Bounds = { maxAgeMs: 30 * 60_000, maxCount: 100, holdMs: 30_000 }

export type Msg = { id: string; channelId: string }

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
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, JSON.stringify(this.ids) + '\n', { mode: 0o600 })
      renameSync(tmp, this.file)
    } catch (err) {
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

// Unique by id, oldest first, the newest maxCount kept; the rest are dropped.
export function select<M extends Msg>(msgs: M[], bounds: Bounds): { keep: M[]; dropped: M[] } {
  const unique = [...new Map(msgs.map(m => [m.id, m])).values()]
  unique.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1))
  const cut = Math.max(0, unique.length - bounds.maxCount)
  return { keep: unique.slice(cut), dropped: unique.slice(0, cut) }
}

export type ReplayOptions<M extends Msg> = {
  cursors: Cursors
  // The live delivery path; late: replayed, or held while the replay ran.
  handle: (m: M, late: boolean) => Promise<void>
  log: (msg: string) => void
  bounds?: Bounds
}

// Single entry for live and replayed messages: each id is handled once, and
// its channel's cursor advances only after handle resolves.
export class Replay<M extends Msg> {
  private held: M[] | null = []
  private claimed = new Set<string>()
  private readonly bounds: Bounds

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

  private async dispatch(m: M, late: boolean): Promise<void> {
    if (!this.claim(m.id)) return
    try {
      await this.o.handle(m, late)
      this.o.cursors.advance(m.channelId, m.id)
    } catch (err) {
      this.o.log(`replay: message ${m.id} in ${m.channelId} not delivered: ${err}`)
    }
  }

  // Fetches and handles the missed messages, then releases the held live ones;
  // live ones wait at most holdMs.
  async run(fetch: (floorOf: (channelId: string) => string | null) => Promise<M[]>, now = Date.now()): Promise<void> {
    const work = this.catchUp(fetch, now)
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
  }

  private async catchUp(fetch: (floorOf: (channelId: string) => string | null) => Promise<M[]>, now: number): Promise<void> {
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
      const { keep, dropped } = select(await fetch(ch => floor(this.o.cursors, ch, now, this.bounds)), this.bounds)
      if (dropped.length > 0) {
        this.o.log(`replay: ${dropped.length} older message(s) over the ${this.bounds.maxCount} cap not replayed: ${dropped[0]!.id}..${dropped.at(-1)!.id}`)
      }
      this.o.log(`replay: ${keep.length} missed message(s)`)
      const byChannel = new Map<string, M[]>()
      for (const m of keep) byChannel.set(m.channelId, [...(byChannel.get(m.channelId) ?? []), m])
      await Promise.all([...byChannel.values()].map(async msgs => {
        for (const m of msgs) await this.dispatch(m, true)
      }))
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

function hasHistory(ch: unknown): ch is History {
  return typeof ch === 'object' && ch !== null && 'messages' in ch && typeof (ch as { isThread?: unknown }).isThread === 'function'
}

// The group channels, their active threads and the known channels, minus the ignored ones.
async function scopeChannels(client: Client, scope: Scope): Promise<History[]> {
  const out = new Map<string, History>()
  const add = (ch: unknown) => {
    if (!hasHistory(ch) || out.has(ch.id)) return
    if (scope.ignored(ch.id, ch.isThread() ? ch.parentId ?? null : null)) return
    out.set(ch.id, ch)
  }
  for (const id of [...scope.groups, ...scope.known]) {
    if (out.has(id) || scope.ignored(id, null)) continue
    const ch = await client.channels.fetch(id).catch((err: unknown) => {
      scope.log(`replay: channel ${id} unavailable: ${err}`)
      return null
    })
    add(ch)
    if (!ch || !scope.groups.includes(id) || !('threads' in ch)) continue
    try {
      const active = await (ch.threads as { fetchActive(): Promise<{ threads: ReadonlyMap<string, unknown> }> }).fetchActive()
      for (const t of active.threads.values()) add(t)
    } catch (err) {
      scope.log(`replay: threads of ${id} unavailable: ${err}`)
    }
  }
  return [...out.values()]
}

// Per channel, the newest messages after its floor, at most maxCount, not the bot's own.
export async function fetchMissed(client: Client, scope: Scope, floorOf: (channelId: string) => string | null, maxCount = BOUNDS.maxCount): Promise<Message[]> {
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
        if (taken >= maxCount) { capped = true; break }
        out.push(m)
        taken++
      }
      if (reached) break
    }
    if (capped) scope.log(`replay: over ${maxCount} messages missed in ${ch.id}; older ones not replayed`)
  }
  return out
}
