import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseAccess } from './access.ts'
import { GroupGate, groupMessageOf, groupPolicy, isIgnoredChannel } from './groupgate.ts'

// testdata/gate-vectors.json, shared with claude-builder's bridge. See DESIGN.md#bot-messages
type Verdict = boolean | { plugin: boolean; bridge: boolean }
type Step = {
  author: string; fromBot: boolean; channel: string; parent: string | null; addressed: boolean; at: number
  length?: number; tagsOthers?: boolean; replyPing?: boolean; embedOnly?: boolean; ownerIsUs?: boolean; expect: Verdict
}
// options: the bridge's own settings, such as ownedThreads; the plugin has none.
type Vector = { name: string; runtimes?: string[]; options?: Record<string, unknown>; group: { allowFrom: string[] }; ignoreChannels?: string[]; steps: Step[] }
const file = JSON.parse(readFileSync(join(import.meta.dir, 'testdata', 'gate-vectors.json'), 'utf8')) as { version: number; vectors: Vector[] }

// The vector's group as the access entry of every channel its steps are gated by, and its ignoreChannels.
function accessOf(v: Vector) {
  const keys = new Set(v.steps.map(s => s.parent ?? s.channel))
  return parseAccess(JSON.stringify({ groups: Object.fromEntries([...keys].map(k => [k, v.group])), ignoreChannels: v.ignoreChannels }))
}

const US = { id: 'us' }

// The step's content: its length, opening with another user's tag when tagsOthers.
function contentOf(s: Step): string {
  if (s.embedOnly) return ''
  const tag = s.tagsOthers ? '<@999> ' : ''
  return tag + 'x'.repeat(Math.max(0, (s.length ?? 2000) - tag.length))
}

// The step as a message for groupMessageOf: replyPing puts us in the mentions as a
// replied user only, as discord.js does for a quote-reply's ping; ownerIsUs makes us the thread's owner.
function messageOf(s: Step) {
  const content = contentOf(s)
  return {
    author: { id: s.author, bot: s.fromBot }, channelId: s.channel, createdTimestamp: s.at, content,
    channel: { isThread: () => s.parent !== null, parentId: s.parent, ownerId: s.ownerIsUs ? US.id : 'other' },
    embeds: { length: s.embedOnly ? 1 : 0 },
    mentions: { has: (u: { id: string }, o?: { ignoreRepliedUser?: boolean }) => u === US && s.replyPing === true && !o?.ignoreRepliedUser },
  }
}

// Each mismatch as "vector #step: what differed"; a denied author or an ignored channel is never asked addressed().
async function mismatches(v: Vector): Promise<string[]> {
  const gate = new GroupGate()
  const access = accessOf(v)
  const out: string[] = []
  for (const [i, s] of v.steps.entries()) {
    let asked = false
    const m = groupMessageOf(messageOf(s), US)
    const got = await gate.admitChannel(access, m, async () => { asked = true; return s.addressed })
    const want = typeof s.expect === 'boolean' ? s.expect : s.expect.plugin
    if (got !== want) out.push(`${v.name} #${i}: got ${got}, want ${want}`)
    const allowFrom = groupPolicy(access.groups, m)?.allowFrom ?? []
    if (asked && allowFrom.length > 0 && !allowFrom.includes(s.author)) out.push(`${v.name} #${i}: addressed() asked for a denied author`)
    if (asked && isIgnoredChannel(access.ignoreChannels, s.channel, s.parent)) out.push(`${v.name} #${i}: addressed() asked in an ignored channel`)
  }
  return out
}

test('the vectors file is version 4', () => {
  expect(file.version).toBe(4)
})

test('every gate vector holds', async () => {
  const applicable = file.vectors.filter(v => !v.runtimes || v.runtimes.includes('plugin'))
  expect(applicable.length).toBeGreaterThan(0)
  expect((await Promise.all(applicable.map(mismatches))).flat()).toEqual([])
})
