# Discord plugin design

## Replay

A restart of the plugin (a container recreate, or Claude Code restarting)
leaves a gap of 30–60 s in which the bot is offline. The gateway does not
redeliver what was posted then, so those messages never reached the agent:
on 2026-10-19 Builder-G missed a review approval addressed to it during its
recreate. `replay.ts` closes the gap; the server only wires it in.

**Last seen.** `replay.json` in the state directory maps each channel or
thread to the id of the last message handled there. The state directory is in
the home volume, so it survives a recreate. Only channels in scope keep a
cursor: DMs from `allowFrom` users, the `access.groups` channels and their
threads, minus `ignoreChannels`. Anything else would be fetched at every
start for nothing. A message counts as handled once the agent has it (the
notification is written; for the Codex and Gemini bridges, the agent took
the input), or once the gate dropped it, since it was seen and judged. A
failed delivery does not advance the cursor. The cursor only moves forward,
entries older than a week are pruned, and each write goes to a unique
temporary file renamed over `replay.json`.

**When.** The replay starts once the gateway is `ready` and Claude Code has
sent `notifications/initialized` (`mcp.oninitialized`), so no notification is
sent before Claude Code listens. Live messages that arrive before then are
held with the rest (below). If the initialized notification has not come
after 30 s, the replay starts anyway with a log line, so live delivery is
never held for good. This ordering is not covered by a test, since the server
starts the gateway and the MCP transport at import; it shows in the plugin's
log, where `replay: N missed message(s)` follows the connect line.

**What is replayed.** Every `access.groups` channel not in `ignoreChannels`,
the active threads under them (one guild-wide `fetchActiveThreads` call per
guild, kept when their parent is a group and they are not ignored, so the
feed thread stays undelivered, as live), and every channel with a cursor (DMs,
threads used lately) is read back to its floor. Private threads the bot has
not joined are not returned by Discord and are skipped. A channel whose
`lastMessageId` is set and not newer than its floor (compared as numbers) is
not read: adding a forum to `access.groups` puts all its active posts in
scope, and a restart then reads only the posts that moved. Without a
`lastMessageId` the channel is read. Every floor is taken
at the start of the replay: the channel's cursor or, for a channel without one
(a thread opened during the gap), the newest cursor of any channel, since ids
are time-ordered snowflakes. Without any saved state, the first start after
an install, nothing is replayed. The bot's own messages are skipped, as live.

**Bound.** The floor is never older than 30 minutes. At most 500 messages a
channel are read, newest first, and every one is judged by the live gate;
then at most 100 of those the gate admits are handed to the agent, the newest.
The cap is applied after the gate so that traffic not addressed to the agent
cannot push out a message that is. Every cut is logged: the time of the last
message seen, the channel read to its cap, the id range over the 100. A
longer outage is not caught up message by message: `fetch_messages` reads
history, and more at once would bury the messages that matter.

**Same path.** A replayed message goes through `judgeInbound` like a live
one: the access gate, `requireMention` and the notification format. The
differences are what a stale message must not do: it never starts a pairing
(no code is sent to a stranger's old DM), a permission reply ("yes abcde")
answered a request of the previous session and is dropped, and no typing
indicator or ack reaction is shown. Its notification carries
`replayed="true"` beside the original `ts`, and the instructions tell Claude
to check whether someone already handled it. A replayed message's quoted
message is looked up only when it survives the cap.

**Order.** Each channel's missed messages are judged oldest first, channels
in parallel, then delivered in id order. Live messages that arrive during the
replay are held until its deliveries are queued, at most 30 s, then handled
in arrival order, so a channel's replayed messages come before its live ones.

**Once.** Live and replayed messages pass one claim per id per process (the
last 2,048 ids). A message posted during the replay is both fetched and
received live; the second claim drops it. Across restarts the cursor excludes
what was handled before.

**Cursor moves during the replay.** While the scan runs, no message moves a
cursor: the scan does not yet know which channels have a gap. After it, a
channel's cursor waits while that channel has replayed messages the agent has
not taken yet, including newer replayed ones already taken; other channels
move at once. When every replayed message of a channel is taken, the channel
moves to the newest message read and to the newest live message that waited.
When one of them fails (the agent refused it, or a bridge's session could
not open), the channel's cursor stays before it: nothing in that channel,
replayed or live, moves it, so a restart replays the failed message again
(at least once).

**The settle bound is a forced release.** Ten minutes after the replay
starts, every cursor still held is forced forward to what was read and
delivered, with a log line naming the channels whose replayed messages were
not taken. Without it, one message the agent never takes would hold its
channel's cursor for the life of the process, and the next restart would
replay up to 100 messages already received. The cost is a loss window: a
message that failed, or that is still waiting in an agent's queue when the
bound fires (a Codex app-server down for more than ten minutes), is skipped
if the container restarts before the agent takes it. The log line is the
record of that.

**Not covered.** The replay runs once per process. A gateway reconnect is
resumed by discord.js, which replays the missed events itself; a session
invalidated mid-run (a new identify) is not caught up.

**One implementation.** This repository is the single source of `replay.ts`
and its test. The Codex and Gemini bridges of iGio90/claude-builder, which
run without this plugin, keep a committed copy generated by their
`image/bridge/sync-replay.ts` from a pinned commit of this repository; a test
there fails when the copy drifts. Change the files here, then re-run the sync
there.

## Bot messages

Several agents share one channel with `requireMention: false`, so every post
by any agent reached every other agent, and each delivery costs the receiver
a full re-read of its context (about 650k cached tokens for Builder-S). In
3 hours on 2026-10-20, 288 of Builder-S's ~360 wakes were posts by another
bot that did not address it. The team rules already say such a post is not
the receiver's to answer; the plugin now drops it before the model pays to
read it.

**Rule.** Per group, opt-in. With `botsRequireMention: true` a message whose
author is a bot (`author.bot`, which webhooks also set) is delivered only when
it is addressed to us: a user mention, a reply to one of our messages, or a
`mentionPatterns` match, the same test as `requireMention`. Humans are
delivered exactly as before, so a developer's untagged message still reaches
every agent. With `botReactions: false`, a bot's reaction on our message is
not delivered; a human's is. A reaction whose user is not known (a partial
user, which guild reactions do not produce since they carry the member)
counts as a bot's. Both default to the old behaviour. Threads use their
parent's entry, as for every group setting. The channel looks the same to
people: nothing is deleted, and the agent can read a dropped message with
`fetch_messages`.

**Split messages.** A post longer than 2,000 characters arrives as several
messages, and only the first carries the mention or the reply. The rule
applies on every path that needs addressing: `requireMention` (true by
default, for humans and bots alike) and a bot's message under
`botsRequireMention`. Until 0.0.11 the plugin answered `requireMention` before
the chain, so parts 2..N of a tagged post were dropped there; the task forum
runs with `requireMention: true`, where a tagged long brief must arrive whole.
A message that needs no addressing (`requireMention: false`, and not a bot's
under `botsRequireMention`) is delivered outright and keeps no chain.

After a message is admitted as addressed, the next messages from the same
author in the same channel follow it while each is posted within 3 s of the
part before it and not before it, at most 8 follow-ups: the first part and 8
more (the Codex bridge's rule and its measurement, claude-builder
`image/bridge/DESIGN.md#turn-gating`: parts arrive about 0.5 s apart). The gap
is measured part to part, not from the first part, because a long message
posted 0.5 s apart would pass 3 s at its seventh part; the cap (16,000
characters after the first) bounds how long an author who keeps posting stays
admitted without a new tag. A tagged part inside a live chain counts as a
follow-up, so a chain never exceeds 8; the next tagged message after the cap
starts a new one. Post times are compared, so a replay judges them as live
delivery did, and a chain expires only against its own author's next
message, never against another author's later post. The chain is kept per
channel and author, at most 2,048 pairs (oldest evicted), in memory. The
allowlist is checked first: a denied author is dropped, addressed or not,
without the quoted-message lookup, and starts no chain.

**Embed-only messages.** A message with embeds and no content (a subagent
card, a status embed) never continues a chain and never starts one; on a path
that needs addressing it is delivered only when it is itself addressed,
which for a card means a quote-reply, since Discord parses mentions from the
content only. Cards post right after their bot's tagged messages, so
treating one as a part would wake the tagged agent for every card, and
letting it start a chain would admit the bot's next untagged text. It does
not break a chain either: the next text part is judged against the last
admitted part. Groups that deliver bot messages unaddressed keep delivering
cards. `server.ts` sets `embedOnly` from `content === ''` and `embeds`.

**In order.** The messages of one author in one channel that need addressing
are judged strictly in arrival order: each waits for the verdict on the one
before it. Without it a first part whose reply check needs a fetch (a reply
to one of our messages older than the last 200 we sent) would still be
pending when its second part is judged, and the second part, finding no
chain yet, would be dropped; the live messages the replay held are released
together and hit this at once. Messages delivered outright and other
channels or authors do not wait. Because later parts wait, the
quoted-message lookup is bounded at 1.5 s and then counts as not a reply to
us: an unbounded `fetchReference` (discord.js retries a slow request; up to
about a minute) would hold every later part of that author.

**Shared vectors.** The Codex and Gemini bridges of claude-builder gate with
an adapted copy of this rule (`image/bridge/turngate.ts`), so the behaviour
is kept as sequence vectors in `testdata/gate-vectors.json`, of which
claude-builder `image/bridge/testdata/` holds a byte copy, chosen over a
cross-repo dependency so neither test suite needs the other's checkout or the
network. Each vector is a group policy and steps (author, channel, post time
`at`, whether it is addressed, `embedOnly`) with the expected verdict; a step
whose runtimes differ on purpose gives `{plugin, bridge}`: the bridge ignores
`requireMention` and needs addressing on every channel message. A vector's
group is the access entry of every channel its steps are gated by (a step's
`parent`, else its `channel`), read through `parseAccess` (`access.ts`, the
loader `server.ts` uses), so a thread step finds the entry only through its
parent. Runners also check that a denied author is never asked whether it
is addressed. A change to the behaviour bumps `version` here and in the copy
in the same pair of commits.

**Replay.** The rule is in `gate()`, which `judgeInbound` runs for live and
replayed messages alike, so a replayed backlog delivers only what addressed
us; the 100-message cap counts after it.

**Limits.** A post meant for every agent that tags nobody now reaches no
agent: a bot that broadcasts must tag each agent it means. A tag added by
editing a post wakes nobody, since edits are not delivered; it is re-posted.
An untagged message within 3 s of the same author's addressed one is taken
as its continuation. A role mention of a role we hold, or `@everyone`,
counts as a mention, as for `requireMention`.

The decision is in `groupgate.ts`, with its tests; `server.ts` only feeds it.

## Reactions in history

With `botReactions: false` an agent is not told when another bot reacts to
its message, and the team's agents no longer acknowledge with reactions, but a
developer's reaction is still part of a message, so `fetch_messages` shows
them: each row ends with
`[emoji count · …]` from the message itself, at no extra cost, and on our own
messages also who reacted (`: name, name`, `…` when more reacted than listed),
which takes one REST call per emoji. Those lookups are bounded: at most 10 per
call, spent on the newest of our messages first, 10 users each, each giving up
after 1.5 s; past the budget, or on a failed lookup, the row keeps the count
alone. `history.ts` renders the rows and is tested; `server.ts` feeds it.

A lookup that gives up (here, or the quoted-message lookup of the bot rule)
only stops waiting: the request keeps running inside discord.js and still
spends rate limit. Whether that bucket is shared with our own `react` and
`reply` calls is unverified; Discord buckets per route, so it is likely
separate from sends but may share the channel's message-read bucket.
