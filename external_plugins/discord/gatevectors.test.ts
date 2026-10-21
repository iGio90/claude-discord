import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseAccess } from './access.ts'
import { GroupGate, groupPolicy, isIgnoredChannel } from './groupgate.ts'

// testdata/gate-vectors.json, shared with claude-builder's bridge. See DESIGN.md#bot-messages
type Verdict = boolean | { plugin: boolean; bridge: boolean }
type Step = {
  author: string; fromBot: boolean; channel: string; parent: string | null; addressed: boolean; at: number
  length?: number; tagsOthers?: boolean; embedOnly?: boolean; expect: Verdict
}
type Vector = { name: string; runtimes?: string[]; group: { allowFrom: string[] }; ignoreChannels?: string[]; steps: Step[] }
const file = JSON.parse(readFileSync(join(import.meta.dir, 'testdata', 'gate-vectors.json'), 'utf8')) as { version: number; vectors: Vector[] }

// The vector's group as the access entry of every channel its steps are gated by, and its ignoreChannels.
function accessOf(v: Vector) {
  const keys = new Set(v.steps.map(s => s.parent ?? s.channel))
  return parseAccess(JSON.stringify({ groups: Object.fromEntries([...keys].map(k => [k, v.group])), ignoreChannels: v.ignoreChannels }))
}

// Each mismatch as "vector #step: what differed"; a denied author or an ignored channel is never asked addressed().
async function mismatches(v: Vector): Promise<string[]> {
  const gate = new GroupGate()
  const access = accessOf(v)
  const out: string[] = []
  for (const [i, s] of v.steps.entries()) {
    let asked = false
    const m = {
      authorId: s.author, fromBot: s.fromBot, channelId: s.channel, parentId: s.parent, at: s.at,
      length: s.length ?? 2000, tagsOthers: s.tagsOthers ?? false, embedOnly: s.embedOnly ?? false,
    }
    const got = await gate.admitChannel(access, m, async () => { asked = true; return s.addressed })
    const want = typeof s.expect === 'boolean' ? s.expect : s.expect.plugin
    if (got !== want) out.push(`${v.name} #${i}: got ${got}, want ${want}`)
    const allowFrom = groupPolicy(access.groups, m)?.allowFrom ?? []
    if (asked && allowFrom.length > 0 && !allowFrom.includes(s.author)) out.push(`${v.name} #${i}: addressed() asked for a denied author`)
    if (asked && isIgnoredChannel(access.ignoreChannels, s.channel, s.parent)) out.push(`${v.name} #${i}: addressed() asked in an ignored channel`)
  }
  return out
}

test('the vectors file is version 2', () => {
  expect(file.version).toBe(2)
})

test('every gate vector holds', async () => {
  const applicable = file.vectors.filter(v => !v.runtimes || v.runtimes.includes('plugin'))
  expect(applicable.length).toBeGreaterThan(0)
  expect((await Promise.all(applicable.map(mismatches))).flat()).toEqual([])
})
