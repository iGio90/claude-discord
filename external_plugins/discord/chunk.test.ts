import { describe, expect, test } from 'bun:test'
import { chunk } from './chunk'

const mention = '<@1559180935600148582>'

describe('chunk', () => {
  test('returns short text untouched', () => {
    expect(chunk('hello', 2000, 'newline')).toEqual(['hello'])
  })

  test('never cuts inside a mention', () => {
    const text = 'a'.repeat(90) + ' ' + mention + ' tail'
    for (const mode of ['length', 'newline'] as const) {
      const parts = chunk(text, 100, mode)
      expect(parts.length).toBeGreaterThan(1)
      for (const p of parts) {
        expect(p.length).toBeLessThanOrEqual(100)
        expect(p.includes('<@') ? p.includes(mention) : true).toBe(true)
      }
      expect(parts.join('')).toContain(mention)
    }
  })

  test('prefers a paragraph boundary', () => {
    const text = 'first paragraph ' + 'x'.repeat(50) + '\n\n' + 'second paragraph ' + 'y'.repeat(50)
    const parts = chunk(text, 90, 'newline')
    expect(parts[0]).toBe('first paragraph ' + 'x'.repeat(50))
    expect(parts[1]).toBe('second paragraph ' + 'y'.repeat(50))
  })

  test('closes and reopens a code fence across chunks', () => {
    const text = 'intro\n```sh\n' + 'echo one\n'.repeat(20) + '```\nafter'
    const parts = chunk(text, 80, 'newline')
    expect(parts.length).toBeGreaterThan(1)
    for (const p of parts) {
      expect(p.length).toBeLessThanOrEqual(80)
      expect((p.match(/```/g) ?? []).length % 2).toBe(0)
    }
    expect(parts[1].startsWith('```sh\n')).toBe(true)
  })

  test('length mode still cuts at the cap outside mentions', () => {
    const parts = chunk('z'.repeat(250), 100, 'length')
    expect(parts.map((p) => p.length)).toEqual([100, 100, 50])
  })
})
