import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseAccess } from './access.ts'
import { GroupGate } from './groupgate.ts'

// testdata/gate-vectors.json, shared with claude-builder's bridge. See DESIGN.md#bot-messages
type Verdict = boolean | { plugin: boolean; bridge: boolean }
type Step = { author: string; fromBot: boolean; channel: string; parent: string | null; addressed: boolean; at: number; embedOnly?: boolean; expect: Verdict }
type Vector = { name: string; runtimes?: string[]; group: { allowFrom: string[] }; steps: Step[] }
const file = JSON.parse(readFileSync(join(import.meta.dir, 'testdata', 'gate-vectors.json'), 'utf8')) as { version: number; vectors: Vector[] }

// The vector's group as the access entry of every channel its steps are gated by.
function groupsOf(v: Vector) {
  const keys = new Set(v.steps.map(s => s.parent ?? s.channel))
  return parseAccess(JSON.stringify({ groups: Object.fromEntries([...keys].map(k => [k, v.group])) })).groups
}

// Each mismatch as "vector #step: what differed"; a denied author is never asked addressed().
async function mismatches(v: Vector): Promise<string[]> {
  const gate = new GroupGate()
  const groups = groupsOf(v)
  const out: string[] = []
  for (const [i, s] of v.steps.entries()) {
    let asked = false
    const got = await gate.admit(
      groups,
      { authorId: s.author, fromBot: s.fromBot, channelId: s.channel, parentId: s.parent, at: s.at, embedOnly: s.embedOnly ?? false },
      async () => { asked = true; return s.addressed },
    )
    const want = typeof s.expect === 'boolean' ? s.expect : s.expect.plugin
    if (got !== want) out.push(`${v.name} #${i}: got ${got}, want ${want}`)
    const allowFrom = v.group.allowFrom
    if (asked && allowFrom.length > 0 && !allowFrom.includes(s.author)) out.push(`${v.name} #${i}: addressed() asked for a denied author`)
  }
  return out
}

test('the vectors file is version 1', () => {
  expect(file.version).toBe(1)
})

test('every gate vector holds', async () => {
  const applicable = file.vectors.filter(v => !v.runtimes || v.runtimes.includes('plugin'))
  expect(applicable.length).toBeGreaterThan(0)
  expect((await Promise.all(applicable.map(mismatches))).flat()).toEqual([])
})
