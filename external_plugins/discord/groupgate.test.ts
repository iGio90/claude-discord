import { expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONTINUATION_MS, GroupGate, MAX_PARTS, isAddressed, reactionAllowed, reactorIsBot, type Addressing, type GroupMessage, type Groups } from './groupgate.ts'
import { Cursors, Replay, snowflakeAt, type Msg } from './replay.ts'

const SHARED = '100'
const HUMAN = '1'
const BOT = '2'
const T = 1_000_000
const tick = (ms: number) => new Promise(r => setTimeout(r, ms))
const on: Groups = { [SHARED]: { requireMention: false, allowFrom: [], botsRequireMention: true, botReactions: false } }
const off: Groups = { [SHARED]: { requireMention: false, allowFrom: [] } }
const msg = (o: Partial<GroupMessage> = {}): GroupMessage => ({ authorId: BOT, fromBot: true, channelId: SHARED, parentId: null, at: T, ...o })
const yes = async () => true
const no = async () => false
const addressing = (o: Partial<Addressing> = {}): Addressing => ({
  mentionsUs: false, content: '', sentByUs: () => false, quotedAuthor: async () => null, ourId: 'us', ...o,
})

test('a bot message not addressed to us is dropped', async () => {
  expect(await new GroupGate().admit(on, msg(), no)).toBe(false)
})

test('a bot message addressed to us is delivered', async () => {
  expect(await new GroupGate().admit(on, msg(), yes)).toBe(true)
})

test('an untagged human message is delivered without asking whether it is addressed', async () => {
  let asked = false
  expect(await new GroupGate().admit(on, msg({ authorId: HUMAN, fromBot: false }), async () => (asked = true))).toBe(true)
  expect(asked).toBe(false)
})

test('without botsRequireMention an untagged bot message is delivered as before', async () => {
  expect(await new GroupGate().admit(off, msg(), no)).toBe(true)
})

test('a thread follows its parent channel', async () => {
  const gate = new GroupGate()
  expect(await gate.admit(on, msg({ channelId: '200', parentId: SHARED }), no)).toBe(false)
  expect(await gate.admit(on, msg({ channelId: '200', parentId: SHARED, fromBot: false }), no)).toBe(true)
})

test('requireMention still applies to humans and bots alike', async () => {
  const groups: Groups = { [SHARED]: { requireMention: true, allowFrom: [], botsRequireMention: true } }
  expect(await new GroupGate().admit(groups, msg({ fromBot: false }), no)).toBe(false)
})

test('the later parts of an addressed bot message follow it within the window', async () => {
  const gate = new GroupGate()
  expect(await gate.admit(on, msg(), yes)).toBe(true)
  expect(await gate.admit(on, msg({ at: T + 500 }), no)).toBe(true)
  expect(await gate.admit(on, msg({ at: T + 500 + CONTINUATION_MS + 1 }), no)).toBe(false)
  expect(await gate.admit(on, msg({ authorId: '3', at: T + 600 }), no)).toBe(false)
})

test('a mention addresses the message', async () => {
  expect(await isAddressed(addressing({ mentionsUs: true }))).toBe(true)
})

test('a reply to a message we sent lately addresses the message', async () => {
  expect(await isAddressed(addressing({ replyTo: 'm1', sentByUs: id => id === 'm1' }))).toBe(true)
})

test('a reply to an older message of ours is found by looking up its author', async () => {
  expect(await isAddressed(addressing({ replyTo: 'm1', quotedAuthor: async () => 'us' }))).toBe(true)
  expect(await isAddressed(addressing({ replyTo: 'm1', quotedAuthor: async () => 'other' }))).toBe(false)
})

test('a mentionPatterns match addresses the message', async () => {
  expect(await isAddressed(addressing({ content: 'hey builder-s' }), ['builder-s'])).toBe(true)
})

test('a bot reaction is dropped under botReactions false, a human one delivered', () => {
  const r = { authorId: BOT, fromBot: true, channelId: SHARED, parentId: null }
  expect(reactionAllowed(on, r)).toBe(false)
  expect(reactionAllowed(on, { ...r, authorId: HUMAN, fromBot: false })).toBe(true)
  expect(reactionAllowed(off, r)).toBe(true)
})

test('a replayed bot message not addressed to us is not handed to the agent', async () => {
  const gate = new GroupGate()
  const base = BigInt(snowflakeAt(Date.now() - 60_000))
  const ids = [base + 1n, base + 2n].map(String)
  const cursors = new Cursors(join(mkdtempSync(join(tmpdir(), 'groupgate-')), 'replay.json'), () => {})
  cursors.advance(SHARED, base.toString())
  const addressed = new Set([ids[1]])
  const handed: string[] = []
  const replay = new Replay<Msg>({
    cursors,
    log: () => {},
    inScope: () => true,
    handle: async () => null,
    prepare: async m => (await gate.admit(on, msg({ at: T + Number(BigInt(m.id) - base) * 10_000 }), async () => addressed.has(m.id)))
      ? async () => { handed.push(m.id); return { taken: Promise.resolve() } }
      : null,
  })
  await replay.run(async () => ids.map(id => ({ id, channelId: SHARED })))
  expect(handed).toEqual([ids[1]!])
})

test('parts judged together wait for the first part\'s verdict', async () => {
  const gate = new GroupGate()
  const slowYes = async () => { await tick(20); return true }
  const [first, second] = await Promise.all([gate.admit(on, msg(), slowYes), gate.admit(on, msg({ at: T + 500 }), no)])
  expect([first, second]).toEqual([true, true])
})

test('a part posted before the last admitted one does not follow it', async () => {
  const gate = new GroupGate()
  expect(await gate.admit(on, msg(), yes)).toBe(true)
  expect(await gate.admit(on, msg({ at: T - 100 }), no)).toBe(false)
})

test('at most MAX_PARTS parts follow an addressed message', async () => {
  const gate = new GroupGate()
  expect(await gate.admit(on, msg(), yes)).toBe(true)
  for (let i = 1; i <= MAX_PARTS; i++) expect(await gate.admit(on, msg({ at: T + i * 500 }), no)).toBe(true)
  expect(await gate.admit(on, msg({ at: T + (MAX_PARTS + 1) * 500 }), no)).toBe(false)
})

test('a reactor without a bot flag counts as a bot', () => {
  expect(reactorIsBot({ bot: null })).toBe(true)
  expect(reactorIsBot({})).toBe(true)
  expect(reactorIsBot({ bot: false })).toBe(false)
})

// A replay whose handle and prepare both go through the gate, at the given post times.
function gatedReplay(gate: GroupGate, at: Record<string, number>, addressed: (id: string) => () => Promise<boolean>, handed: string[]) {
  const base = BigInt(snowflakeAt(Date.now() - 60_000))
  const cursors = new Cursors(join(mkdtempSync(join(tmpdir(), 'groupgate-')), 'replay.json'), () => {})
  cursors.advance(SHARED, base.toString())
  const judge = (m: Msg) => gate.admit(on, msg({ at: at[m.id]! }), addressed(m.id))
  const replay = new Replay<Msg>({
    cursors,
    log: () => {},
    inScope: () => true,
    handle: async m => (await judge(m)) ? (handed.push(m.id), { taken: Promise.resolve() }) : null,
    prepare: async m => (await judge(m)) ? async () => { handed.push(m.id); return { taken: Promise.resolve() } } : null,
  })
  return { replay, id: (n: number) => (base + BigInt(n)).toString() }
}

test('replayed parts of a split message within the window are delivered, a later one is not', async () => {
  const handed: string[] = []
  const at: Record<string, number> = {}
  const { replay, id } = gatedReplay(new GroupGate(), at, i => (i === id(1) ? yes : no), handed)
  at[id(1)] = T; at[id(2)] = T + 500; at[id(3)] = T + 500 + CONTINUATION_MS + 1
  await replay.run(async () => [1, 2, 3].map(n => ({ id: id(n), channelId: SHARED })))
  expect(handed).toEqual([id(1), id(2)])
})

test('two held parts released together are both delivered', async () => {
  const handed: string[] = []
  const at: Record<string, number> = {}
  const slowYes = async () => { await tick(20); return true }
  const { replay, id } = gatedReplay(new GroupGate(), at, i => (i === id(1) ? slowYes : no), handed)
  at[id(1)] = T; at[id(2)] = T + 500
  await replay.run(async () => {
    replay.live({ id: id(1), channelId: SHARED })
    replay.live({ id: id(2), channelId: SHARED })
    return []
  })
  await tick(50)
  expect(handed).toEqual([id(1), id(2)])
})

test('a quoted-message lookup that hangs counts as not addressed and does not hold the next part', async () => {
  const gate = new GroupGate()
  const hanging = () => isAddressed(addressing({ replyTo: 'm1', quotedAuthor: () => new Promise(() => {}) }), [], 20)
  const first = gate.admit(on, msg(), hanging)
  const second = gate.admit(on, msg({ at: T + 500 }), yes)
  expect(await Promise.race([Promise.all([first, second]), tick(200).then(() => 'blocked')])).toEqual([false, true])
})
