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
not joined are not returned by Discord and are skipped. Every floor is taken
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

**Cursor moves during the replay.** While the scan runs, no live message
moves a cursor: the scan does not yet know which channels have a gap. After
it, a channel's cursor waits only while that channel has replayed messages
the agent has not taken yet; other channels move at once. When the last of a
channel's replayed messages is taken, or fails (the agent refused it, or a
bridge's session could not open), the channel moves to the newest message
read and to the newest live message that waited. A restart before that
replays the gap again rather than skipping it: a message may arrive twice,
never zero times. A failed replayed message is logged and not retried; the
live messages after it move the cursor past it, as for a failed live one.
Waiting is bounded: after 10 minutes every pending move is released with a
log line, so an agent that never takes a message (a stuck session) cannot
freeze the cursors for the life of the process.

**Not covered.** The replay runs once per process. A gateway reconnect is
resumed by discord.js, which replays the missed events itself; a session
invalidated mid-run (a new identify) is not caught up.

**One implementation.** This repository is the single source of `replay.ts`
and its test. The Codex and Gemini bridges of iGio90/claude-builder, which
run without this plugin, keep a committed copy generated by their
`image/bridge/sync-replay.ts` from a pinned commit of this repository; a test
there fails when the copy drifts. Change the files here, then re-run the sync
there.
