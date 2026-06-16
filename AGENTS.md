# pi-monitor

Pi extension that watches background processes and delivers regex-matching
stdout windows (with before/after context) to the agent session.

Partial pseudo-fork of [pi-monitor-plugin](https://github.com/Shodocan/pi-monitor-plugin) by Walisson Casonatto — ported the monitor tool and core infrastructure (ProcessRunner, MonitorEngine, ReDoS protection, nonce-fencing), dropped background/loop/schedule tools.

## Features

- **Regex matching** — only forward lines matching a pattern
- **Before/after context** — deliver surrounding lines with each match
- **Debouncing** — batch nearby matches into a single delivery
- **ReDoS protection** — vet regex patterns before execution
- **Nonce-fencing** — untrusted output is fenced with cryptographic nonces
- **Secret redaction** — best-effort scrubbing of tokens, keys, passwords
- **ANSI stripping** — remove terminal escape sequences from output
- **Idle/busy routing** — deliver immediately if idle, queue if busy

## Installation

```bash
pi install npm:pi-monitor
# or locally:
pi install /path/to/pi-monitor
```

## Tools

### `Monitor`

Run a shell command in the background and watch stdout for regex matches.

```
Monitor command="tail -f /var/log/app.log" regex="error|warn" before=5 after=3
```

Parameters:
- `command` (required) — shell command to run
- `regex` (required) — regex pattern to match against each stdout line
- `regexFlags` (optional) — RegExp flags (default: '')
- `before` (optional) — lines of context before match (0-200, default: 10)
- `after` (optional) — lines of context after match (0-200, default: 10)
- `debounceSeconds` (optional) — debounce window (1-60, default: 5)
- `label` (optional) — human-readable label

## Commands

| Command | Description |
|---------|-------------|
| `/monitor --regex <pattern> -- <cmd>` | Start a monitor |
| `/monitor-stop <jobID>` | Stop a running monitor |
| `/monitor-list` | Interactive menu: list monitors, view tail, stop |

AI-callable tools: `Monitor`, `MonitorStop`, `MonitorList`.

## `/monitor-list` menu

Interactive TUI for inspecting and managing running monitors.

- Lists all active monitors, **newest first**
- Detail pane shows the **last 10 stdout lines** of the selected monitor (live refreshes every 1s)
- **Up/Down**: navigate the list
- **Enter / s**: stop the selected monitor (with confirm if `confirmStop` is true)
- **x**: stop the selected monitor (skip confirm — kill semantics)
- **Esc / q**: close the menu

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
