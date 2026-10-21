// Guild-channel delivery: the channel's policy, who may post there and whether
// a message or reaction must be addressed to the bot. See DESIGN.md#bot-messages
export const CONTINUATION_MS = 3_000
export const MAX_PARTS = 8
export const QUOTE_LOOKUP_MS = 1_500
// A part shorter than this ends its message: every splitter cuts non-final parts longer.
export const SPLIT_FLOOR = 1_000
const PARTS_CAP = 2_048
const TAG = /<@!?\d+>|<@&\d+>|@everyone|@here/

// An author's split message: the post time and length of its last admitted
// part, and how many parts followed the addressed one.
type Chain = { last: number; length: number; count: number }

export type GroupPolicy = {
  requireMention: boolean
  allowFrom: string[]
  /** Messages from bots are delivered only when addressed to us. Default false. */
  botsRequireMention?: boolean
  /** Reactions from bots are delivered. Default true. */
  botReactions?: boolean
}

export type Groups = Record<string, GroupPolicy>

// A guild-channel message or reaction; at is the message's post time, length its
// content's, tagsOthers whether it tags someone but not us (see tagsOthers).
export type GroupEvent = { authorId: string; fromBot: boolean; channelId: string; parentId: string | null }
export type GroupMessage = GroupEvent & { at: number; length: number; embedOnly: boolean; tagsOthers: boolean }

// Who may post where, as read from access.json.
export type ChannelAccess = { groups: Groups; ignoreChannels?: string[] }

// What tells whether a message is addressed to us; quotedAuthor may cost a
// fetch and counts as unknown after lookupMs. See DESIGN.md#bot-messages
export type Addressing = {
  mentionsUs: boolean
  replyTo?: string
  content: string
  sentByUs: (id: string) => boolean
  quotedAuthor: () => Promise<string | null>
  ourId?: string
}

// A message with embeds and no content, such as a subagent card.
export function embedOnly(content: string, embeds: number): boolean {
  return content === '' && embeds > 0
}

// The content tags a user, a role, @everyone or @here, and we are not mentioned.
export function tagsOthers(content: string, mentionsUs: boolean): boolean {
  return !mentionsUs && TAG.test(content)
}

// True when the channel, or a thread's parent, is in ignoreChannels.
export function isIgnoredChannel(ignoreChannels: string[] | undefined, channelId: string, parentId?: string | null): boolean {
  if (!ignoreChannels || ignoreChannels.length === 0) return false
  return ignoreChannels.includes(channelId) || (parentId != null && ignoreChannels.includes(parentId))
}

// Threads are gated by their parent channel's entry.
export function groupPolicy(groups: Groups, e: { channelId: string; parentId: string | null }): GroupPolicy | undefined {
  return groups[e.parentId ?? e.channelId]
}

function allowed(policy: GroupPolicy, authorId: string): boolean {
  const allowFrom = policy.allowFrom ?? []
  return allowFrom.length === 0 || allowFrom.includes(authorId)
}

// requireMention, or a bot's message under botsRequireMention.
function needsAddressing(policy: GroupPolicy, m: GroupMessage): boolean {
  return (policy.requireMention ?? true) || (m.fromBot && policy.botsRequireMention === true)
}

// A mention, a reply to one of our messages, or a mentionPatterns match.
export async function isAddressed(a: Addressing, patterns?: string[], lookupMs = QUOTE_LOOKUP_MS): Promise<boolean> {
  if (a.mentionsUs) return true
  if (a.replyTo) {
    if (a.sentByUs(a.replyTo)) return true
    let timer: ReturnType<typeof setTimeout> | undefined
    const author = await Promise.race([
      a.quotedAuthor().catch(() => null),
      new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), lookupMs) }),
    ])
    clearTimeout(timer)
    if (author !== null && author === a.ourId) return true
  }
  for (const pat of patterns ?? []) {
    try {
      if (new RegExp(pat, 'i').test(a.content)) return true
    } catch {}
  }
  return false
}

// Whether a reactor counts as a bot; a partial user with no flag does.
export function reactorIsBot(user: { bot?: boolean | null }): boolean {
  return user.bot ?? true
}

// The reactor passes the channel's allowlist; a bot only when botReactions is not false.
export function reactionAllowed(groups: Groups, r: GroupEvent): boolean {
  const policy = groupPolicy(groups, r)
  if (!policy || !allowed(policy, r.authorId)) return false
  return !(r.fromBot && policy.botReactions === false)
}

// Remembers each author's split message per channel, so its later parts follow
// the addressed first one, judged in order. See DESIGN.md#bot-messages
export class GroupGate {
  private parts = new Map<string, Chain>()
  private pending = new Map<string, Promise<void>>()

  constructor(private readonly windowMs = CONTINUATION_MS, private readonly maxParts = MAX_PARTS) {}

  // admit, behind ignoreChannels: an ignored channel or parent is dropped first.
  async admitChannel(access: ChannelAccess, m: GroupMessage, addressed: () => Promise<boolean>): Promise<boolean> {
    if (isIgnoredChannel(access.ignoreChannels, m.channelId, m.parentId)) return false
    return this.admit(access.groups, m, addressed)
  }

  // True when the message is delivered; addressed is asked only when it decides.
  async admit(groups: Groups, m: GroupMessage, addressed: () => Promise<boolean>): Promise<boolean> {
    const policy = groupPolicy(groups, m)
    if (!policy || !allowed(policy, m.authorId)) return false
    if (!needsAddressing(policy, m)) return true
    return this.inOrder(this.key(m), () => this.judge(m, addressed))
  }

  // Runs judge after the previous verdict for the same channel and author.
  private inOrder(key: string, judge: () => Promise<boolean>): Promise<boolean> {
    const verdict = (this.pending.get(key) ?? Promise.resolve()).then(judge)
    const tail = verdict.then(() => {}, () => {})
    this.pending.set(key, tail)
    void tail.then(() => {
      if (this.pending.get(key) === tail) this.pending.delete(key)
    })
    return verdict
  }

  // An embed-only message neither continues nor starts a chain.
  private async judge(m: GroupMessage, addressed: () => Promise<boolean>): Promise<boolean> {
    if (m.embedOnly) return addressed()
    const key = this.key(m)
    const chain = this.parts.get(key)
    if (chain && this.follows(chain, m)) {
      this.put(key, { last: m.at, length: m.length, count: chain.count + 1 })
      return true
    }
    if (!(await addressed())) return false
    this.put(key, { last: m.at, length: m.length, count: 0 })
    return true
  }

  // A next part: tags nobody else, after a split-length part, in the window, below the cap.
  private follows(chain: Chain, m: GroupMessage): boolean {
    if (m.tagsOthers || chain.length < SPLIT_FLOOR) return false
    return m.at >= chain.last && m.at - chain.last <= this.windowMs && chain.count < this.maxParts
  }

  private key(m: GroupMessage): string {
    return `${m.channelId}:${m.authorId}`
  }

  private put(key: string, chain: Chain): void {
    this.parts.delete(key)
    this.parts.set(key, chain)
    if (this.parts.size > PARTS_CAP) this.parts.delete(this.parts.keys().next().value!)
  }
}
