# Discord plugin design

## Replay

A restart of the plugin (a container recreate, or Claude Code restarting)
leaves a gap of 30–60 s in which the bot is offline. The gateway does not
redeliver what was posted then, so those messages never reached the agent:
on 2026-10-19 Builder-G missed a review approval addressed to it during its
recreate. `replay.ts` closes the gap; the server only wires it in.

**Last seen.** `replay.json` in the state directory maps each channel or
thread to the id of the last message handled there. The state directory is in
the home volume, so it survives a recreate. A message counts as handled once
`handleInbound` resolves: delivered to Claude, or dropped by the gate (not
allowlisted, an ignored channel), since that message was seen and judged. A
notification that fails does not advance the cursor. The cursor only moves
forward, and entries older than a week are pruned, which bounds the file.

**What is replayed.** At the first gateway `ready`, every channel in
`access.groups` that is not in `ignoreChannels`, the active threads of those
channels except ignored ones (so the feed thread stays undelivered, as live),
and every channel with a cursor (DMs, threads used lately) is read back to its
floor. The floor is the channel's cursor or, for a channel without one (a
thread opened during the gap), the newest cursor of any channel: ids are
time-ordered snowflakes, so anything after it was posted while the bot was
down. Without any saved state, the first start after an install, nothing is
replayed. The bot's own messages are skipped, as live.

**Bound.** The floor is never older than 30 minutes, and at most 100
messages are replayed, per channel (read newest first) and in total; the
oldest are dropped. Both cuts are logged, with the time of the last message
seen or the dropped id range. A longer outage is not caught up message by
message: the agent can read history with `fetch_messages`, and 100 messages at
once would bury the ones addressed to it.

**Same path.** Replayed messages go through `handleInbound`, so the access
gate, `requireMention`, permission replies and the notification format are
those of a live message; the `ts` attribute shows when it was posted. Each
channel's messages are delivered oldest first, channels in parallel. Live
messages that arrive during the replay are held until it ends, at most 30 s,
then handled in arrival order, so a channel's replayed messages come before
its live ones.

**Once.** Live and replayed messages enter through one `Replay.live` /
`dispatch`, which claims each id once per process (the last 2,048 ids). A
message posted during the replay is both fetched and received live; the second
claim drops it. Across restarts the cursor excludes everything handled before.
A process killed between a notification and its cursor write delivers that
message once more at the next start: at least once was preferred to losing it.

**Not covered.** The replay runs once per process. A gateway reconnect is
resumed by discord.js, which replays the missed events itself; a session
invalidated mid-run (a new identify) is not caught up.

**One implementation.** The Codex and Gemini agents of iGio90/claude-builder
receive Discord through their own bridge (`image/bridge/`), which runs without
this plugin. Their `image/bridge/replay.ts` and its test are identical copies
of these files, each naming its twin; a change lands in both. A package both
could import would need a registry or a git dependency on a subdirectory,
which neither repository uses.
