# @clanker-code/pi-monitor

npm: `@clanker-code/pi-monitor` · GitHub: `clankercode/pi-monitor`
(npm scope has a hyphen; GitHub org does not).

Pi extension that watches background processes and delivers regex-matching
stdout windows (with before/after context) to the agent session, plus
fire-and-forget background shell jobs that notify only on exit.

**Partial pseudo-fork** of [pi-monitor-plugin](https://github.com/Shodocan/pi-monitor-plugin)
by Walisson Casonatto — ported the monitor tool and core infrastructure
(ProcessRunner, MonitorEngine, ReDoS protection, nonce-fencing), dropped
loop/schedule tools, reintroduced a reduced Background job type, and added
triggerTurn/steer delivery, same-turn batching, XML envelopes, exit
notifications, full output log paths, compact TUI renderers, and an interactive
`/monitor-list` menu. Full divergence list lives in [README.md](./README.md#fork-divergences).

## Features

- **Regex matching** — only forward lines matching a pattern
- **Before/after context** — deliver surrounding lines with each match
- **Debouncing** — batch nearby matches into a single delivery
- **Background jobs** — shell commands with no intermediate deliveries (`bg_*` ids)
- **Exit notifications** — agent is notified when any job exits (code, last lines, log path)
- **Full output logs** — every job tees stdout/stderr to a file on disk
- **No polling** — all agent-facing copy states that match and exit are push-delivered
- **ReDoS protection** — vet regex patterns before execution
- **Nonce-fencing** — untrusted output is fenced with cryptographic nonces
- **Secret redaction** — best-effort scrubbing of tokens, keys, passwords
- **ANSI stripping** — remove terminal escape sequences from output
- **Idle/busy routing** — deliver immediately if idle, queue if busy

## Installation

```bash
pi install npm:@clanker-code/pi-monitor
# or locally:
pi install /path/to/pi-monitor
```

## Tools

### `Monitor`

Run a shell command in the background and watch stdout for regex matches.
Matching windows and process exit are delivered automatically — **do not poll**.

```
Monitor command="tail -f /var/log/app.log" regex="error|warn" before=5 after=3
```

Parameters:
- `command` (required) — shell command to run
- `regex` (optional) — regex pattern to match against each stdout line (default: match all)
- `regexFlags` (optional) — RegExp flags (default: '')
- `before` (optional) — lines of context before match (0-200, default: 0)
- `after` (optional) — lines of context after match (0-200, default: 0)
- `debounceSeconds` (optional) — debounce window (0-60, default: 0)
- `label` (optional) — human-readable label
- `triggerTurn` (optional) — wake agent on match (default: true); exit always wakes

### `Background`

Run a shell command in the background with **no intermediate deliveries**
(exit-only). Same ProcessRunner and exit envelope as monitors; ids are `bg_N`.
**Do not poll** — you will be notified when the job exits.

```
Background command="pnpm build" label="build"
```

Parameters:
- `command` (required) — shell command to run
- `label` (optional) — human-readable label

### Exit notification

When any job ends (natural exit, crash, or stop), the agent receives a steer
message with:

- exit code (and signal if killed)
- last ~8 lines of process output
- path to the full output log file

Log files live under `{tmpdir}/pi-monitor/{pid}/{jobID}.log` and survive dispose.

## Commands

| Command | Description |
|---------|-------------|
| `/monitor-stop <jobID>` | Stop a running monitor or background job |
| `/monitor-list` | Interactive menu: list jobs, view tail, stop |

AI-callable tools: `Monitor`, `Background`, `MonitorStop`, `MonitorList`.

## `/monitor-list` menu

Interactive TUI for inspecting and managing running jobs (monitors + background).

- Lists all active jobs, **newest first**
- Detail pane shows the **last 10 stdout lines** of the selected job (live refreshes every 1s)
- **Up/Down**: navigate the list
- **Enter / s**: stop the selected job (with confirm if `confirmStop` is true)
- **x**: stop the selected job (skip confirm — kill semantics)
- **Esc / q / Left**: close the menu (or go back one level from details)

### Settings

The menu reads one setting from `<cwd>/.pi/pi-monitor.json` (project) or `~/.pi/agent/pi-monitor.json` (global); project overrides global.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `confirmStop` | boolean | `true` | Whether Enter/s asks for confirmation before stopping |

Example `<cwd>/.pi/pi-monitor.json`:
```json
{ "confirmStop": false }
```

## Development

```bash
pnpm install
pnpm test
pnpm check
```
