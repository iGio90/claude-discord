// Guild-channel delivery: the channel's policy, who may post there and whether
// a message or reaction must be addressed to the bot. See DESIGN.md#bot-messages
export const CONTINUATION_MS = 3_000
const PARTS_CAP = 2_048

export type GroupPolicy = {
  requireMention: boolean
  allowFrom: string[]
  /** Messages from bots are delivered only when addressed to us. Default false. */
  botsRequireMention?: boolean
  /** Reactions from bots are delivered. Default true. */
  botReactions?: boolean
}

export type Groups = Record<string, GroupPolicy>

// A guild-channel message or reaction; at is the message's post time.
export type GroupEvent = { authorId: string; fromBot: boolean; channelId: string; parentId: string | null }
export type GroupMessage = GroupEvent & { at: number }

// What tells whether a message is addressed to us; quotedAuthor may cost a fetch.
export type Addressing = {
  mentionsUs: boolean
  replyTo?: string
  content: string
  sentByUs: (id: string) => boolean
  quotedAuthor: () => Promise<string | null>
  ourId?: string
}

// Threads are gated by their parent channel's entry.
export function groupPolicy(groups: Groups, e: { channelId: string; parentId: string | null }): GroupPolicy | undefined {
  return groups[e.parentId ?? e.channelId]
}

function allowed(policy: GroupPolicy, authorId: string): boolean {
  const allowFrom = policy.allowFrom ?? []
  return allowFrom.length === 0 || allowFrom.includes(authorId)
}

// A mention, a reply to one of our messages, or a mentionPatterns match.
export async function isAddressed(a: Addressing, patterns?: string[]): Promise<boolean> {
  if (a.mentionsUs) return true
  if (a.replyTo) {
    if (a.sentByUs(a.replyTo)) return true
    const author = await a.quotedAuthor()
    if (author !== null && author === a.ourId) return true
  }
  for (const pat of patterns ?? []) {
    try {
      if (new RegExp(pat, 'i').test(a.content)) return true
    } catch {}
  }
  return false
}

// The reactor passes the channel's allowlist; a bot only when botReactions is not false.
export function reactionAllowed(groups: Groups, r: GroupEvent): boolean {
  const policy = groupPolicy(groups, r)
  if (!policy || !allowed(policy, r.authorId)) return false
  return !(r.fromBot && policy.botReactions === false)
}

// Remembers each bot's last admitted message per channel, so the later parts
// of a split message follow the first. See DESIGN.md#bot-messages
export class GroupGate {
  private parts = new Map<string, number>()

  constructor(private readonly windowMs = CONTINUATION_MS) {}

  // True when the message is delivered; addressed is asked only when it decides.
  async admit(groups: Groups, m: GroupMessage, addressed: () => Promise<boolean>): Promise<boolean> {
    const policy = groupPolicy(groups, m)
    if (!policy || !allowed(policy, m.authorId)) return false
    if (policy.requireMention ?? true) return addressed()
    if (!m.fromBot || policy.botsRequireMention !== true) return true
    if (!this.follows(m) && !(await addressed())) return false
    this.note(m)
    return true
  }

  private key(m: GroupMessage): string {
    return `${m.channelId}:${m.authorId}`
  }

  private follows(m: GroupMessage): boolean {
    const last = this.parts.get(this.key(m))
    return last !== undefined && m.at >= last && m.at - last <= this.windowMs
  }

  private note(m: GroupMessage): void {
    const key = this.key(m)
    this.parts.delete(key)
    this.parts.set(key, m.at)
    if (this.parts.size > PARTS_CAP) this.parts.delete(this.parts.keys().next().value!)
  }
}
