// Copied into iGio90/claude-builder image/bridge/ by its sync-replay.ts; edit it here.
import { expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { BOUNDS, Cursors, Replay, fetchMissed, floor, newer, select, snowflakeAt, type Handed, type Msg, type ReplayOptions } from './replay.ts'

const NOW = Date.parse('2026-10-19T12:00:00Z')
const MIN = 60_000
const idAt = (ms: number, n = 0) => (BigInt(snowflakeAt(ms)) + BigInt(n)).toString()
// An id from a minute ago; the cursor prunes entries older than a week.
const live = (n: number) => idAt(Date.now() - MIN, n)
const cursorFile = () => join(mkdtempSync(join(tmpdir(), 'replay-')), 'replay.json')
const tick = (ms: number) => new Promise(r => setTimeout(r, ms))
const taken = (): Handed => ({ taken: Promise.resolve() })

// A replay whose gate admits every message, unless told otherwise.
function replayOf(cursors: Cursors, over: Partial<ReplayOptions<Msg>> = {}) {
  return new Replay<Msg>({
    cursors,
    log: () => {},
    inScope: () => true,
    handle: async () => taken(),
    prepare: async () => async () => taken(),
    ...over,
  })
}

test('a cursor advances only forward and survives a restart, leaving no temp file', () => {
  const file = cursorFile()
  const a = new Cursors(file, () => {})
  a.advance('1', idAt(NOW - MIN), NOW)
  a.advance('1', idAt(NOW - 2 * MIN), NOW)
  expect(new Cursors(file, () => {}).get('1')).toBe(idAt(NOW - MIN))
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ '1': idAt(NOW - MIN) })
  expect(readdirSync(dirname(file))).toEqual(['replay.json'])
})

test('the cursor advances only once the agent has the message', async () => {
  const cursors = new Cursors(cursorFile(), () => {})
  const [a, b] = [live(1), live(2)]
  let take!: () => void
  const replay = replayOf(cursors, {
    handle: async m => {
      if (m.id === b) throw new Error('mcp closed')
      return { taken: new Promise<void>(r => (take = r)) }
    },
  })
  await replay.run(async () => [])
  replay.live({ id: a, channelId: '1' })
  replay.live({ id: b, channelId: '2' })
  await tick(5)
  expect(cursors.get('1')).toBeUndefined()
  take()
  await tick(5)
  expect(cursors.get('1')).toBe(a)
  expect(cursors.get('2')).toBeUndefined()
})

test('a channel out of scope keeps no cursor', async () => {
  const cursors = new Cursors(cursorFile(), () => {})
  const replay = replayOf(cursors, { inScope: m => m.channelId !== '7' })
  await replay.run(async () => [])
  replay.live({ id: live(1), channelId: '7' })
  replay.live({ id: live(2), channelId: '1' })
  await tick(5)
  expect(cursors.channels()).toEqual(['1'])
})

test('the replay floor is the cursor, never older than the age bound', () => {
  const cursors = new Cursors(cursorFile(), () => {})
  expect(floor(cursors, '1', NOW, BOUNDS)).toBeNull()
  cursors.advance('1', idAt(NOW - 5 * MIN), NOW)
  cursors.advance('2', idAt(NOW - 60 * MIN), NOW)
  expect(floor(cursors, '1', NOW, BOUNDS)).toBe(idAt(NOW - 5 * MIN))
  expect(floor(cursors, '2', NOW, BOUNDS)).toBe(snowflakeAt(NOW - BOUNDS.maxAgeMs))
  expect(floor(cursors, '3', NOW, BOUNDS)).toBe(idAt(NOW - 5 * MIN))
})

test('past the count bound the oldest are dropped', () => {
  const { keep, dropped } = select([3, 1, 2, 2].map(n => ({ id: String(n) })), 2)
  expect(keep.map(m => m.id)).toEqual(['2', '3'])
  expect(dropped.map(m => m.id)).toEqual(['1'])
})

test('the count bound applies after the gate, so unaddressed traffic does not push out an addressed message', async () => {
  const cursors = new Cursors(cursorFile(), () => {})
  const id = [0, 1, 2, 3, 4].map(live)
  cursors.advance('1', id[0]!)
  const delivered: string[] = []
  const replay = replayOf(cursors, {
    bounds: { ...BOUNDS, maxCount: 1 },
    prepare: async m => (m.id === id[1] ? async () => { delivered.push(m.id); return taken() } : null),
  })
  await replay.run(async () => id.slice(1).map(i => ({ id: i, channelId: '1' })))
  expect(delivered).toEqual([id[1]!])
  expect(cursors.get('1')).toBe(id[4])
})

test('a message held live during the replay and also replayed is handled once, after the replay', async () => {
  const cursors = new Cursors(cursorFile(), () => {})
  const id = [5, 6, 7, 8, 9].map(live)
  cursors.advance('1', id[0]!)
  const handled: string[] = []
  const name = (m: Msg) => String(id.indexOf(m.id) + 5)
  const replay = replayOf(cursors, {
    handle: async (m, late) => { handled.push(`${name(m)}${late ? 'H' : ''}`); return taken() },
    prepare: async m => async () => { handled.push(`${name(m)}R`); return taken() },
  })
  replay.live({ id: id[2]!, channelId: '1' })
  replay.live({ id: id[3]!, channelId: '1' })
  await replay.run(async () => [{ id: id[1]!, channelId: '1' }, { id: id[2]!, channelId: '1' }])
  replay.live({ id: id[3]!, channelId: '1' })
  replay.live({ id: id[4]!, channelId: '1' })
  await tick(5)
  expect(handled).toEqual(['6R', '7R', '8H', '9'])
  expect(cursors.get('1')).toBe(id[4])
})

test('a replay that outlasts the hold reads every floor as of its start and keeps the gap until it is taken', async () => {
  const cursors = new Cursors(cursorFile(), () => {})
  const [start, missed, held] = [live(1), live(2), live(3)]
  cursors.advance('1', start)
  cursors.advance('2', start)
  const floors: (string | null)[] = []
  const replay = replayOf(cursors, { bounds: { ...BOUNDS, holdMs: 20 } })
  replay.live({ id: held, channelId: '2' })
  const run = replay.run(async floorOf => {
    await tick(60)
    floors.push(floorOf('2'), floorOf('3'))
    return [{ id: missed, channelId: '2' }]
  })
  await tick(40)
  expect(cursors.get('2')).toBe(start)
  await run
  expect(floors).toEqual([start, start])
  expect(cursors.get('2')).toBe(held)
})

test('a replayed message never taken does not hold the cursor of another channel', async () => {
  const cursors = new Cursors(cursorFile(), () => {})
  const [start, stuck, a, b] = [live(1), live(2), live(3), live(4)]
  cursors.advance('1', start)
  cursors.advance('2', start)
  const replay = replayOf(cursors, { prepare: async () => async () => ({ taken: new Promise<void>(() => {}) }) })
  void replay.run(async () => [{ id: stuck, channelId: '1' }])
  await tick(5)
  replay.live({ id: a, channelId: '1' })
  replay.live({ id: b, channelId: '2' })
  await tick(5)
  expect(cursors.get('2')).toBe(b)
  expect(cursors.get('1')).toBe(start)
})

test('a replayed message that fails keeps its channel cursor before it', async () => {
  const cursors = new Cursors(cursorFile(), () => {})
  const [start, failed, after, other] = [live(1), live(2), live(3), live(4)]
  cursors.advance('B', start)
  cursors.advance('A', start)
  const replay = replayOf(cursors, { prepare: async () => async () => ({ taken: Promise.reject(new Error('session/new failed')) }) })
  await replay.run(async () => [{ id: failed, channelId: 'B' }])
  replay.live({ id: after, channelId: 'B' })
  replay.live({ id: other, channelId: 'A' })
  await tick(5)
  expect(cursors.get('B')).toBe(start)
  expect(cursors.get('A')).toBe(other)
})

test('a newer replayed message taken does not move the cursor past an older one that failed', async () => {
  const cursors = new Cursors(cursorFile(), () => {})
  const [start, older, newer] = [live(1), live(2), live(3)]
  cursors.advance('1', start)
  const replay = replayOf(cursors, {
    prepare: async m => async () => ({ taken: m.id === older ? Promise.reject(new Error('refused')) : Promise.resolve() }),
  })
  await replay.run(async () => [{ id: older, channelId: '1' }, { id: newer, channelId: '1' }])
  await tick(5)
  expect(cursors.get('1')).toBe(start)
})

test('the settle bound forces past a failed replayed message, and says so', async () => {
  const cursors = new Cursors(cursorFile(), () => {})
  const [start, failed, after] = [live(1), live(2), live(3)]
  cursors.advance('1', start)
  const logs: string[] = []
  const replay = replayOf(cursors, {
    bounds: { ...BOUNDS, settleMs: 30 },
    log: l => logs.push(l),
    prepare: async () => async () => ({ taken: Promise.reject(new Error('refused')) }),
  })
  await replay.run(async () => [{ id: failed, channelId: '1' }])
  replay.live({ id: after, channelId: '1' })
  await tick(5)
  expect(cursors.get('1')).toBe(start)
  await tick(40)
  expect(cursors.get('1')).toBe(after)
  expect(logs.some(l => l.includes('are skipped'))).toBe(true)
})

test('past the settle bound every deferred cursor move is released', async () => {
  const cursors = new Cursors(cursorFile(), () => {})
  const [start, stuck, after] = [live(1), live(2), live(3)]
  cursors.advance('1', start)
  const logs: string[] = []
  const replay = replayOf(cursors, {
    bounds: { ...BOUNDS, settleMs: 30 },
    log: l => logs.push(l),
    prepare: async () => async () => ({ taken: new Promise<void>(() => {}) }),
  })
  const run = replay.run(async () => [{ id: stuck, channelId: '1' }])
  await tick(5)
  replay.live({ id: after, channelId: '1' })
  await run
  expect(cursors.get('1')).toBe(after)
  expect(logs.some(l => l.includes('forcing every cursor forward'))).toBe(true)
})

test('without saved state nothing is fetched', async () => {
  let fetched = false
  await replayOf(new Cursors(cursorFile(), () => {})).run(async () => { fetched = true; return [] })
  expect(fetched).toBe(false)
})

const BOT = '9'
type Fake = { id: string; author: { id: string } }

function channel(id: string, msgs: Fake[], parentId: string | null = null, threads: { id: string }[] = [], lastMessageId?: string | null) {
  return {
    id,
    parentId,
    lastMessageId,
    isThread: () => parentId !== null,
    messages: {
      fetch: async ({ limit, before }: { limit: number; before?: string }) => new Map(
        msgs.filter(m => before === undefined || newer(before, m.id))
          .sort((a, b) => (newer(a.id, b.id) ? -1 : 1))
          .slice(0, limit)
          .map(m => [m.id, m]),
      ),
    },
    guild: { id: 'g', channels: { fetchActiveThreads: async () => ({ threads: new Map(threads.map(t => [t.id, t])) }) } },
  }
}

test('the replay covers the shared channel and its active threads, not ignored or foreign threads or own messages', async () => {
  const old = { id: idAt(NOW - 10 * MIN), author: { id: '1' } }
  const zap = channel('20', [{ id: idAt(NOW - MIN, 1), author: { id: '1' } }], '10')
  const feed = channel('21', [{ id: idAt(NOW - MIN, 2), author: { id: '1' } }], '10')
  const foreign = channel('22', [{ id: idAt(NOW - MIN, 5), author: { id: '1' } }], '99')
  const shared = channel('10', [old, { id: idAt(NOW - MIN, 3), author: { id: '1' } }, { id: idAt(NOW - MIN, 4), author: { id: BOT } }], null, [zap, feed, foreign])
  const all: Record<string, unknown> = { 10: shared, 20: zap, 21: feed, 22: foreign }
  const client = { user: { id: BOT }, channels: { fetch: async (id: string) => all[id] ?? null } }
  const got = await fetchMissed(client as never, {
    groups: ['10'],
    ignored: (id, parentId) => id === '21' || parentId === '21',
    known: [],
    log: () => {},
  }, () => idAt(NOW - 5 * MIN))
  expect(got.map(m => m.id).sort()).toEqual([idAt(NOW - MIN, 1), idAt(NOW - MIN, 3)].sort())
})

test('a channel with more missed messages than the fetch cap yields its newest ones', async () => {
  const msgs = Array.from({ length: 250 }, (_, i) => ({ id: idAt(NOW - MIN, i), author: { id: '1' } }))
  const client = { user: { id: BOT }, channels: { fetch: async () => channel('10', msgs) } }
  const logs: string[] = []
  const got = await fetchMissed(client as never, { groups: ['10'], ignored: () => false, known: [], log: l => logs.push(l) }, () => idAt(NOW - 5 * MIN), 120)
  expect(got.length).toBe(120)
  expect(got.map(m => m.id)).toContain(idAt(NOW - MIN, 249))
  expect(got.map(m => m.id)).not.toContain(idAt(NOW - MIN, 129))
  expect(logs.some(l => l.includes('older ones not read'))).toBe(true)
})

// A shared channel whose one active thread has the given last message id; reads of the thread are counted.
function quietThread(lastMessageId: string | null | undefined) {
  const reads = { n: 0 }
  const thread = channel('20', [{ id: idAt(NOW - 10 * MIN), author: { id: '1' } }], '10', [], lastMessageId)
  const fetch = thread.messages.fetch
  thread.messages.fetch = async o => { reads.n++; return fetch(o) }
  const shared = channel('10', [], null, [thread])
  const client = { user: { id: BOT }, channels: { fetch: async (id: string) => ({ 10: shared, 20: thread } as Record<string, unknown>)[id] ?? null } }
  return { client, reads }
}

const scope = { groups: ['10'], ignored: () => false, known: [], log: () => {} }

test('a thread with nothing newer than the floor is not fetched', async () => {
  const { client, reads } = quietThread(idAt(NOW - 10 * MIN))
  await fetchMissed(client as never, scope, () => idAt(NOW - 5 * MIN))
  expect(reads.n).toBe(0)
})

test('a channel without a last message id is fetched', async () => {
  const { client, reads } = quietThread(null)
  await fetchMissed(client as never, scope, () => idAt(NOW - 5 * MIN))
  expect(reads.n).toBe(1)
})

test('the last message id is compared to the floor as a number', async () => {
  const { client, reads } = quietThread('99')
  await fetchMissed(client as never, scope, () => '100')
  expect(reads.n).toBe(0)
})
