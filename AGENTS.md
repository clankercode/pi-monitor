# pi-monitor

Pi extension that watches background processes and feeds their stdout lines
as events to the agent session. Like Bash `run_in_background` but push-based:
each stdout line arrives as a notification, no polling required.

## Features

- **Push-based monitoring** — each stdout line is sent to the agent as it arrives
- **Regex filtering** — only forward lines matching a pattern
- **Auto-stop** — monitors that produce too many events are automatically stopped
- **Session-scoped** — monitors stop when the session exits
- **Multiple monitors** — run several monitors concurrently

## Installation

```bash
pi install npm:pi-monitor
# or locally:
pi install /path/to/pi-monitor
```

## Tools

### `monitor`

Start a background monitor.

```
monitor command="tail -f /var/log/app.log" filter="error|warn" label="app-logs"
```

Parameters:
- `command` (required) — shell command to run
- `filter` (optional) — regex pattern, only matching lines are forwarded
- `label` (optional) — human-readable label shown in notifications

### `monitor_stop`

Stop a running monitor by ID.

```
monitor_stop id="monitor-1"
```

### `monitor_list`

List all running monitors.

```
monitor_list
```

## Commands

| Command | Description |
|---------|-------------|
| `/monitor` | Show running monitors |

## Use Cases

- **Deploy monitoring** — tail deploy logs, flag errors immediately
- **CI status** — watch `gh run list` polling until a run finishes
- **File watching** — watch a directory for changes
- **Test streaming** — stream test runner output, surface failures as they occur
- **Dev servers** — watch for errors in dev server output

## Development

```bash
pnpm install
pnpm test
pnpm check
```
