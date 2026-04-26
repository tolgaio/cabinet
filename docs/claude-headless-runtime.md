# Claude Headless Runtime

A multica-style headless adapter for running Claude Code as a single-shot subprocess instead of inside a `node-pty` pseudo-terminal. Opt-in alongside the existing PTY and `claude_local` paths. Lives in `src/lib/agents/adapters/claude-headless.ts`.

## Why this exists

Cabinet's heartbeat agents (CEO, CTO, DevOps, etc.) were being marked `failed` despite producing complete output, populated `meta.json` summaries, and on-disk artifacts. Investigation in `/home/tolga/src/tolgaio/beads/cabinet/heartbeat-tasks-marked-failed-after-pty-timeout.md` identified the cause: the existing PTY runtime relies on a regex tail-match (`hasClaudePromptTail` in `src/lib/agents/conversation-store.ts:562-581`) plus a 1.2-second grace timer (`CLAUDE_AUTO_EXIT_GRACE_MS` in `server/cabinet-daemon.ts:173`) to decide that a session has finished. Claude Code's TUI status-bar redraws (token counters, unrecognised spinner verbs like `Herding`, `Whirlpooling`, `Transmuting`) cancel that grace timer repeatedly, so the auto-exit detector never fires. The 600-second hard kill (`src/lib/agents/heartbeat.ts:384`) eventually wins, the daemon sees a non-zero exit, and `cabinet-daemon.ts:387` persists the run as `failed`.

Bumping the hard timeout doesn't help — the detector still misses completion regardless of budget. The structural fix is to stop scraping a TUI and consume Claude's structured event stream directly. `tolgaio/multica` (Go) had already implemented this pattern; this PR ports it to the Cabinet daemon.

## What the adapter does

`src/lib/agents/adapters/claude-headless.ts` spawns Claude with:

```
claude
  -p
  --output-format stream-json
  --input-format stream-json
  --verbose
  --strict-mcp-config
  --permission-mode bypassPermissions
  [--model <id>]
  [--max-turns <n>]
  [--append-system-prompt <text>]
  [--resume <session-id>]
```

No PTY. `child_process.spawn` with `stdio: ["pipe","pipe","pipe"]`. Environment built by `buildHeadlessEnv()` filters out any `CLAUDECODE*` and `CLAUDE_CODE_*` variables so a parent Claude harness can't leak its session into the child.

The initial prompt is written to stdin as a stream-json envelope:

```json
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"<prompt>"}]}}
```

Stdin is then closed. With `--input-format stream-json`, an open stdin signals "more turns coming" — closing it tells Claude this is a single-shot run. Multi-turn happens by spawning a fresh process with `--resume <prior_session_id>`, not by keeping a long-lived pipe.

Stdout is consumed line by line via `readline.createInterface`. Each line is parsed as JSON and normalised by `normalizeMessage` into Cabinet's internal event shape:

| Claude type | Cabinet event |
|---|---|
| `system` | `system` (captures `session_id`) |
| `assistant` text block | `text` |
| `assistant` thinking block | `thinking` |
| `assistant` tool_use block | `tool_use` |
| `user` tool_result block | `tool_result` |
| `result` | `result` (with `isError`) |
| `log` | `log` |
| `control_request` | `control_request_auto_allowed` (auto-replies `behavior: "allow"`) |
| any other | `unknown` |

Every normalised event is appended (one JSON object per line) to `events.jsonl` next to the existing `transcript.txt`. Display text is also forwarded to the daemon's `onLog` callback so the existing transcript-based UI keeps working unchanged.

## Selecting the runtime

Resolution order (`src/lib/agents/adapters/registry.ts`):

1. Explicit `adapterType: "claude_headless"` on the request, persona, or job.
2. `CABINET_DEFAULT_CLAUDE_RUNTIME=headless` env var.
3. Provider default (`claude_local`).

Env values: `headless`, `local` / `structured`, `pty` / `legacy`. The docker-compose file in `~/.cabinet/cabinet-docker/docker-compose.yml` ships with `CABINET_DEFAULT_CLAUDE_RUNTIME=headless`.

## Conversation diagnostics

`ConversationMeta` (`src/types/conversations.ts`) was extended with:

- `runtime: "pty" | "headless" | "structured"`
- `durationMs: number`
- `signal: number | null`
- `timedOut: boolean`
- `killReason: "timeout" | "user-stop" | "exit" | "crash"`
- `resolvedStatusSource: "auto-exit" | "adapter" | "exit-code-fallback" | "timeout"`

Daemon's `finalizeSessionConversation` (`server/cabinet-daemon.ts`) populates them from session state. The task detail panel renders a runtime badge (e.g. `Sonnet 4.6 · Claude Code · Headless`) plus a diagnostics line (e.g. `9m 12s · timed out · signal 15 · timeout · timeout`).

## Bugs found and fixed during deployment

Two follow-up commits land on this PR after the initial implementation:

### 1. Stdin left open → Claude parks in `ep_poll`

After deploying the adapter inside the docker container, the heartbeat produced complete output and artifacts — but the `claude -p` process never exited and the UI kept showing the conversation as `running`.

Smoking-gun snapshot from `/proc/520` (PID 520 = the hung claude inside the container):

```
$ docker exec cabinet sh -c 'cat /proc/520/status | head -10'
Name:    claude
Umask:   0022
State:   S (sleeping)
Tgid:    520
Ngid:    0
Pid:     520
PPid:    83
TracerPid: 0
Uid:     1000  1000  1000  1000
Gid:     1000  1000  1000  1000

$ docker exec cabinet sh -c 'cat /proc/520/wchan; echo'
ep_poll

$ docker exec cabinet sh -c 'cat /proc/520/syscall'
cat: /proc/520/syscall: Operation not permitted

$ docker exec cabinet sh -c 'ls -l /proc/520/fd'
lrwx------ 1 cabinet cabinet 64 Apr 26 17:34 0 -> 'socket:[23678482]'
lrwx------ 1 cabinet cabinet 64 Apr 26 17:34 1 -> 'socket:[23678484]'
lrwx------ 1 cabinet cabinet 64 Apr 26 17:34 2 -> 'socket:[23678486]'
lr-x------ 1 cabinet cabinet 64 Apr 26 17:34 3 -> /dev/urandom
lrwx------ 1 cabinet cabinet 64 Apr 26 17:26 13 -> 'anon_inode:[eventpoll]'
lrwx------ 1 cabinet cabinet 64 Apr 26 17:34 14 -> 'anon_inode:[timerfd]'
lrwx------ 1 cabinet cabinet 64 Apr 26 17:34 15 -> 'anon_inode:[eventfd]'
... (claude config + neo settings + KB paths) ...

$ docker exec cabinet sh -c 'cat /proc/520/io'
rchar: 3734421
wchar: 391067
syscr: 6046
syscw: 5215
read_bytes: 0
write_bytes: 331776
cancelled_write_bytes: 65536
```

How to read this:

- **`State: S (sleeping)`** — voluntarily blocked, not stuck on the CPU. Healthy parked state.
- **`wchan: ep_poll`** — the kernel call the process is parked in is `epoll_wait`. That is libuv's main event loop wait. Claude (a Node app under the hood) is idle in its own event loop, waiting for *any* stream event to arrive on any of the file descriptors it's watching.
- **`fd 0 -> socket:[23678482]`** — stdin is a live UNIX-domain socket pair. The socket-vs-pipe distinction is normal: when one Node process spawns another with `stdio: ['pipe', …]`, libuv uses `socketpair(2)` for full-duplex friendliness. The relevant fact is that the file descriptor is **still open at both ends**.
- **`PPid: 83`** — parent is the cabinet daemon Node process. As long as that parent holds the write end of the stdin socket pair open, Claude can never see EOF on stdin and so can never decide that the user is done sending turns. With `--input-format stream-json`, Claude treats stdin as a stream of follow-up user messages. No EOF, no exit.
- **`syscall: Operation not permitted`** — expected inside an unprivileged container; the kernel hides syscall arguments from non-root readers in some configurations. Not relevant to the diagnosis.
- **IO counters** — `rchar` 3.5 MB read, `wchar` 382 KB written. Substantial. Claude did its real work, emitted its `result` event, and then sat down to wait for more. The hang is *after* the productive phase.
- **Open files** — `~/.claude/sessions`, `~/.claude/cache`, `~/.claude/credentials.json`, the neo MCP config, etc. Confirms it's a normal claude-code session, not a corrupted state.

Cross-checked against multica's headless runner (`/home/tolga/src/github/multica/server/pkg/agent/claude.go:99`):

```go
closeStdin := func() {
    if stdin != nil {
        _ = stdin.Close()
        stdin = nil
    }
}
// …
if err := writeClaudeInput(stdin, prompt); err != nil {
    closeStdin()
    cancel()
    _ = cmd.Wait()
    return nil, fmt.Errorf("write claude input: %w", err)
}
closeStdin()  // ← unconditionally close right after writing the prompt
```

Multica closes stdin immediately after writing the prompt. Combined with `--permission-mode bypassPermissions` (no permission round-trips needed) this gives a clean single-shot lifecycle. Multica even has a `handleControlRequest` function that's never wired into its event loop — confirming the design choice: bypassPermissions + closed stdin = no control protocol needed.

Fix: after `writeToStdin(buildInitialPromptEnvelope(ctx.prompt))`, call `child.stdin.end()`. Errors swallowed by the existing stdin error handler. Single-line behavioural change; Claude now exits 0 within seconds of emitting its `result` event.

### 2. Readline race → adapter `execute()` never returned

After fixing the stdin hang, claude exited cleanly — but the UI still showed the conversation as `running`. Daemon logs showed `Session … started via HTTP (agent mode)` but no matching `… exited` line.

Cause: the adapter's `runHeadless` was awaiting two things in sequence:

1. `child.on("close")` — the child process fully closed.
2. `stdoutLines.once("close")` — defensively wait for the readline interface to emit `close`.

By the time step 1 resolves, the child's stdout has already ended, which means readline auto-closed and emitted its `close` event. Step 2's `.once("close", …)` listener is therefore added *after* the event has fired and waits forever. `execute()` never returns, the daemon's structured-session `await execute(ctx)` parks, and `finalizeSessionConversation` is never called.

Fix: drop the second await. The line handlers have already run by the time the child closes, so `acc.finalText` and `events.jsonl` are populated. Defensively call `stdoutLines.close()` only if `stdoutLines.closed` is false.

After both fixes the lifecycle is:

```
spawn → write prompt envelope → close stdin → readline consumes events →
  child exits 0 after `result` event → adapter returns →
  daemon finalizeSessionConversation writes meta.status = "completed",
  runtime = "headless", durationMs ≈ real elapsed time
```

## Verification

Restart the container so the latest build runs:

```
docker compose -f /home/tolga/.cabinet/cabinet-docker/docker-compose.yml restart
```

Trigger any persona heartbeat from the UI.

While it's running, count claude processes:

```
docker exec cabinet sh -c '
for p in /proc/[0-9]*; do
  c=$(tr "\0" " " < "$p/cmdline" 2>/dev/null)
  case "$c" in *claude*\ -p\ *) echo "$(basename $p): $c";; esac
done'
```

Expected: exactly one PID during the active phase, none after the run finishes.

After the conversation status flips to `completed`, inspect the meta:

```
ls -t cabinet-data/.agents/.conversations/ | head -1 | \
  xargs -I{} cat cabinet-data/.agents/.conversations/{}/meta.json
```

Expected fields: `status: "completed"`, `exitCode: 0`, `runtime: "headless"`, `durationMs` matching real elapsed time, `killReason: "exit"`, `resolvedStatusSource: "adapter"`, populated `summary` / `contextSummary` / `artifactPaths`.

Check `events.jsonl`:

```
ls -t cabinet-data/.agents/.conversations/ | head -1 | \
  xargs -I{} sh -c 'awk -F"\"type\":\"" "{n=split(\$0,a,\"\\\"type\\\":\\\"\"); for(i=2;i<=n;i++){split(a[i],b,\"\\\"\"); print b[1]}}" cabinet-data/.agents/.conversations/{}/events.jsonl | sort | uniq -c | sort -rn'
```

Expected: a `result` event present, `system` events at start, plus tool_use / tool_result / text / thinking events from the run.

To diagnose a future hang, repeat the `/proc` snapshot from the section above against whichever PID is stuck.

## Trade-offs and follow-ups

- The headless runtime cannot service interactive `WebTerminal` sessions — those still need the PTY path. Per `CLAUDE.md` rule 8, the terminal isn't going away. Leave the PTY adapter registered and selectable for that use case.
- `events.jsonl` is currently consumed by no UI; the existing dashboard still reads `transcript.txt`. A structured-events viewer is a sensible next step (richer tool-call rendering, per-event timestamps, expandable thinking blocks).
- `--resume <session_id>` is wired into adapter args but not yet plumbed through Cabinet's conversation flow — capturing the `session_id` from the `system` event and feeding it on follow-up turns is an open follow-up.
- Once the runtime has soaked for a few weeks of real usage, consider promoting `claude_headless` over `claude_local` as the in-code default and demoting `claude_local`.
