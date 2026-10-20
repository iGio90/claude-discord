// The rows fetch_messages returns, reactions included. See DESIGN.md#reactions-in-history
export const MAX_REACTOR_LOOKUPS = 10
export const MAX_REACTORS = 10

// users: who reacted, when looked up (on our own messages only).
export type ReactionSummary = { emoji: string; count: number; users?: string[] }

export type HistoryMessage = {
  ts: string
  who: string
  content: string
  id: string
  attachments: number
  reactions: ReactionSummary[]
}

// A unicode emoji as is, a custom one as :name:.
export function emojiLabel(e: { id: string | null; name: string | null }): string {
  return e.id ? `:${e.name ?? e.id}:` : e.name ?? ''
}

const oneLine = (s: string) => s.replace(/[\r\n]+/g, ' ⏎ ')

function reaction(r: ReactionSummary): string {
  const users = r.users && r.users.length > 0
    ? `: ${r.users.map(oneLine).join(', ')}${r.users.length < r.count ? ', …' : ''}`
    : ''
  return `${oneLine(r.emoji)} ${r.count}${users}`
}

// One line per message; multi-line content is folded so it cannot forge rows.
export function historyRow(m: HistoryMessage): string {
  const atts = m.attachments > 0 ? ` +${m.attachments}att` : ''
  const reactions = m.reactions.length > 0 ? `  [${m.reactions.map(reaction).join(' · ')}]` : ''
  return `[${m.ts}] ${m.who}: ${oneLine(m.content)}  (id: ${m.id}${atts})${reactions}`
}
