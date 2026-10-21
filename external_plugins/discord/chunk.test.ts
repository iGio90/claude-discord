import { expect, test } from 'bun:test'
import { chunk } from './chunk.ts'

test('a newline-mode part never ends before half the limit', () => {
  const text = 'a ' + 'x'.repeat(2500)
  const parts = chunk(text, 2000, 'newline')
  expect(parts[0]!.length).toBe(2000)
  expect(parts.join('')).toBe(text)
})

test('newline mode still cuts at the last paragraph past half the limit', () => {
  const text = 'x'.repeat(1500) + '\n\n' + 'y'.repeat(1000)
  expect(chunk(text, 2000, 'newline')).toEqual(['x'.repeat(1500), 'y'.repeat(1000)])
})
