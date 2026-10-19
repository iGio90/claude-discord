// Twin of iGio90/claude-builder image/bridge/replay.test.ts: keep both identical but for this line.
import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BOUNDS, Cursors, Replay, fetchMissed, floor, newer, select, snowflakeAt, type Msg } from './replay.ts'

const NOW = Date.parse('2026-10-19T12:00:00Z')
const MIN = 60_000
const idAt = (ms: number, n = 0) => (BigInt(snowflakeAt(ms)) + BigInt(n)).toString()
const cursorFile = () => join(mkdtempSync(join(tmpdir(), 'replay-')), 'replay.json')
// An id from a minute ago; the cursor prunes entries older than a week.
const live = (n: number) => idAt(Date.now() - MIN, n)
const tick = (ms: number) => new Promise(r => setTimeout(r, ms))

test('a cursor advances only forward and survives a restart', () => {
  const file = cursorFile()
  const a = new Cursors(file, () => {})
  a.advance('1', idAt(NOW - MIN), NOW)
  a.advance('1', idAt(NOW - 2 * MIN), NOW)
  expect(new Cursors(file, () => {}).get('1')).toBe(idAt(NOW - MIN))
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ '1': idAt(NOW - MIN) })
})

test('the cursor advances only after the message is handled', async () => {
  const cursors = new Cursors(cursorFile(), () => {})
  const [a, b] = [live(1), live(2)]
  const replay = new Replay<Msg>({ cursors, log: () => {}, handle: async m => { if (m.id === b) throw new Error('mcp closed') } })
  await replay.run(async () => [])
  replay.live({ id: a, channelId: '1' })
  replay.live({ id: b, channelId: '2' })
  await tick(5)
  expect(cursors.get('1')).toBe(a)
  expect(cursors.get('2')).toBeUndefined()
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

test('past the count bound the oldest messages are dropped', () => {
  const msgs = [3, 1, 2, 2].map(n => ({ id: String(n), channelId: '1' }))
  const { keep, dropped } = select(msgs, { ...BOUNDS, maxCount: 2 })
  expect(keep.map(m => m.id)).toEqual(['2', '3'])
  expect(dropped.map(m => m.id)).toEqual(['1'])
})

test('a message held live during the replay and also replayed is handled once, after the replay', async () => {
  const cursors = new Cursors(cursorFile(), () => {})
  const id = [5, 6, 7, 8, 9].map(live)
  cursors.advance('1', id[0]!)
  const handled: string[] = []
  const replay = new Replay<Msg>({ cursors, log: () => {}, handle: async (m, late) => { handled.push(`${id.indexOf(m.id) + 5}${late ? 'L' : ''}`) } })
  replay.live({ id: id[2]!, channelId: '1' })
  replay.live({ id: id[3]!, channelId: '1' })
  await replay.run(async () => [{ id: id[1]!, channelId: '1' }, { id: id[2]!, channelId: '1' }])
  await tick(5)
  replay.live({ id: id[3]!, channelId: '1' })
  replay.live({ id: id[4]!, channelId: '1' })
  await tick(5)
  expect(handled).toEqual(['6L', '7L', '8L', '9'])
  expect(cursors.get('1')).toBe(id[4])
})

test('without saved state nothing is fetched', async () => {
  let fetched = false
  const replay = new Replay<Msg>({ cursors: new Cursors(cursorFile(), () => {}), log: () => {}, handle: async () => {} })
  await replay.run(async () => { fetched = true; return [] })
  expect(fetched).toBe(false)
})

const BOT = '9'
type Fake = { id: string; author: { id: string } }

function channel(id: string, msgs: Fake[], parentId: string | null = null, threads: unknown[] = []) {
  return {
    id,
    parentId,
    isThread: () => parentId !== null,
    messages: {
      fetch: async ({ limit, before }: { limit: number; before?: string }) => new Map(
        msgs.filter(m => before === undefined || newer(before, m.id))
          .sort((a, b) => (newer(a.id, b.id) ? -1 : 1))
          .slice(0, limit)
          .map(m => [m.id, m]),
      ),
    },
    threads: { fetchActive: async () => ({ threads: new Map(threads.map(t => [(t as { id: string }).id, t])) }) },
  }
}

test('the replay covers the shared channel and its active threads, not ignored threads or own messages', async () => {
  const old = { id: idAt(NOW - 10 * MIN), author: { id: '1' } }
  const zap = channel('20', [{ id: idAt(NOW - MIN, 1), author: { id: '1' } }], '10')
  const feed = channel('21', [{ id: idAt(NOW - MIN, 2), author: { id: '1' } }], '10')
  const shared = channel('10', [old, { id: idAt(NOW - MIN, 3), author: { id: '1' } }, { id: idAt(NOW - MIN, 4), author: { id: BOT } }], null, [zap, feed])
  const all: Record<string, unknown> = { 10: shared, 20: zap, 21: feed }
  const client = { user: { id: BOT }, channels: { fetch: async (id: string) => all[id] ?? null } }
  const got = await fetchMissed(client as never, {
    groups: ['10'],
    ignored: (id, parentId) => id === '21' || parentId === '21',
    known: [],
    log: () => {},
  }, () => idAt(NOW - 5 * MIN))
  expect(got.map(m => m.id).sort()).toEqual([idAt(NOW - MIN, 1), idAt(NOW - MIN, 3)].sort())
})

test('a channel with more missed messages than the bound yields its newest ones', async () => {
  const msgs = Array.from({ length: 250 }, (_, i) => ({ id: idAt(NOW - MIN, i), author: { id: '1' } }))
  const client = { user: { id: BOT }, channels: { fetch: async () => channel('10', msgs) } }
  const logs: string[] = []
  const got = await fetchMissed(client as never, { groups: ['10'], ignored: () => false, known: [], log: l => logs.push(l) }, () => idAt(NOW - 5 * MIN), 120)
  expect(got.length).toBe(120)
  expect(got.map(m => m.id)).toContain(idAt(NOW - MIN, 249))
  expect(got.map(m => m.id)).not.toContain(idAt(NOW - MIN, 129))
  expect(logs.some(l => l.includes('older ones not replayed'))).toBe(true)
})
