// access.json: who may reach the bot and how each guild channel is gated.
import type { Groups } from './groupgate.ts'

export type PendingEntry = {
  senderId: string
  chatId: string // DM channel ID — where to send the approval confirm
  createdAt: number
  expiresAt: number
  replies: number
}

export type Access = {
  dmPolicy: 'pairing' | 'allowlist' | 'disabled'
  allowFrom: string[]
  /** Keyed on channel ID (snowflake), not guild ID. One entry per guild channel. */
  groups: Groups
  pending: Record<string, PendingEntry>
  mentionPatterns?: string[]
  /** Channel IDs whose messages and reactions are never delivered; threads follow their parent. Outbound is unaffected. */
  ignoreChannels?: string[]
  // delivery/UX config — optional, defaults live in the reply handler
  /** Emoji to react with on receipt. Empty string disables. Unicode char or custom emoji ID. */
  ackReaction?: string
  /** Which chunks get Discord's reply reference when reply_to is passed. Default: 'first'. 'off' = never thread. */
  replyToMode?: 'off' | 'first' | 'all'
  /** Max chars per outbound message before splitting. Default: 2000 (Discord's hard cap). */
  textChunkLimit?: number
  /** Split on paragraph boundaries instead of hard char count. */
  chunkMode?: 'length' | 'newline'
}

export function defaultAccess(): Access {
  return {
    dmPolicy: 'pairing',
    allowFrom: [],
    groups: {},
    pending: {},
  }
}

// Keeps the string entries of an array; anything else yields [].
function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

// Parses access.json; throws on malformed JSON. Missing fields take their defaults.
export function parseAccess(raw: string): Access {
  const parsed = JSON.parse(raw) as Partial<Access>
  return {
    dmPolicy: parsed.dmPolicy ?? 'pairing',
    allowFrom: parsed.allowFrom ?? [],
    groups: parsed.groups ?? {},
    pending: parsed.pending ?? {},
    mentionPatterns: parsed.mentionPatterns,
    ignoreChannels: parsed.ignoreChannels === undefined ? undefined : strings(parsed.ignoreChannels),
    ackReaction: parsed.ackReaction,
    replyToMode: parsed.replyToMode,
    textChunkLimit: parsed.textChunkLimit,
    chunkMode: parsed.chunkMode,
  }
}
