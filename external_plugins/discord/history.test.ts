import { expect, test } from 'bun:test'
import { emojiLabel, historyRow, type HistoryMessage } from './history.ts'

const row = (o: Partial<HistoryMessage> = {}): HistoryMessage => ({
  ts: '2026-10-20T12:00:00.000Z', who: 'me', content: '<@1> ready for review', id: '42', attachments: 0, reactions: [], ...o,
})

test('a message without reactions keeps the old row', () => {
  expect(historyRow(row())).toBe('[2026-10-20T12:00:00.000Z] me: <@1> ready for review  (id: 42)')
})

test('reactions show emoji and count, and who reacted when known', () => {
  const r = historyRow(row({ attachments: 1, reactions: [{ emoji: '👀', count: 2, users: ['builder-g', 'igio90'] }, { emoji: '👍', count: 1 }] }))
  expect(r).toBe('[2026-10-20T12:00:00.000Z] me: <@1> ready for review  (id: 42 +1att)  [👀 2: builder-g, igio90 · 👍 1]')
})

test('a partial list of reactors is marked', () => {
  expect(historyRow(row({ reactions: [{ emoji: '👀', count: 12, users: ['a', 'b'] }] }))).toEndWith('[👀 12: a, b, …]')
})

test('multi-line content stays on one row', () => {
  expect(historyRow(row({ content: 'a\nb' }))).toContain('me: a ⏎ b  (id: 42)')
})

test('a custom emoji is shown by name', () => {
  expect(emojiLabel({ id: '9', name: 'ship' })).toBe(':ship:')
  expect(emojiLabel({ id: null, name: '👍' })).toBe('👍')
})
