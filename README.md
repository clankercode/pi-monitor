# @clanker-code/pi-monitor

| | |
|---|---|
| **npm** | [`@clanker-code/pi-monitor`](https://www.npmjs.com/package/@clanker-code/pi-monitor) — scope `@clanker-code` |
| **GitHub** | [`clankercode/pi-monitor`](https://github.com/clankercode/pi-monitor) — org `clankercode` (no hyphen) |

Naming is intentional and easy to mix up: **npm uses the hyphen** (`@clanker-code/…`); **this repo lives under GitHub `clankercode`** (no hyphen).

A [pi](https://pi.dev) extension that watches background processes and delivers **regex-matching stdout windows** (with before/after context) into the agent session, plus **background shell jobs** that notify only on exit.

This is a **partial pseudo-fork** of [`pi-monitor-plugin`](https://github.com/Shodocan/pi-monitor-plugin) by [Walisson Casonatto (Shodocan)](https://github.com/Shodocan). Upstream planned a broader jobs surface (background / monitor / loop / schedule). We ported the **monitor** tool and its core infrastructure, then rebuilt delivery, TUI, and agent integration for our direction. Upstream changes are reviewed when useful; we do not merge blindly.

> **Status:** Working monitor + background extension. Not a drop-in replacement for the full planned upstream jobs suite (loop/schedule omitted).

**Do not poll.** Matching output and process exits are delivered automatically as steer messages. Exit notifications include exit code, last lines of output, and a path to the full process log.

## Features

- **Regex matching** — only forward lines that match a pattern (default: match everything)
- **Before/after context** — deliver surrounding lines with each match
- **Debouncing** — batch nearby matches into a single delivery
- **Background jobs** — fire-and-forget shell commands (`bg_*`); no intermediate deliveries; notify on exit
- **Exit notifications** — every job end steers the agent with exit code, last lines, and full log path
- **Full output logs** — stdout/stderr tee'd to `{tmpdir}/pi-monitor/{pid}/{jobID}.log`
- **No-poll contract** — tool descriptions and start/exit messages tell agents not to poll
- **`triggerTurn` (default on)** — wake/steer the assistant when matching output arrives; set `false` for display-only logging (exits always wake)
- **ReDoS protection** — vet regex patterns before execution
- **Nonce-fencing** — untrusted output is fenced with cryptographic nonces
- **XML envelope** — delivered windows wrapped for LLM context (`id` + `at`; exits add `event="exit"`)
- **Secret redaction** — best-effort scrubbing of tokens, keys, passwords
- **ANSI stripping** — remove terminal escape sequences from output
- **Idle/busy routing** — deliver immediately if idle; queue/invalidate safely across session lifecycle
- **Same-turn batching** — group monitor deliveries that fire together
- **Interactive `/monitor-list` TUI** — live tail, stop with confirm, keyboard nav
- **AI-callable tools** — `Monitor`, `Background`, `MonitorStop`, `MonitorList`

## Fork divergences

This package intentionally diverges from upstream. Keep this table honest on every release.

| Feature | Status | Notes |
|---------|--------|-------|
| Package identity | ✅ shipped | **npm:** `@clanker-code/pi-monitor` (hyphenated scope). **GitHub:** `clankercode/pi-monitor` (no hyphen). |
| Monitor + Background | ✅ shipped | Ported ProcessRunner, MonitorEngine, ReDoS, nonce-fencing, redaction, ANSI strip. **Dropped** loop/schedule. **Reintroduced** reduced Background tool (`bg_*`, exit-only). |
| Working implementation | ✅ shipped | Upstream README describes a planning/scaffold jobs package; this repo is a usable extension. |
| Exit notifications | ✅ shipped | Process exit always steers the agent with exit code, last ~8 lines, and full log path. Fixes silent disappear from list. |
| Full output log path | ✅ shipped | Every job tees stream-tagged lines to a durable log file; path returned on start and exit. |
| AI tools: stop + list | ✅ shipped | `MonitorStop` and `MonitorList` cover mon_* and bg_* (not only slash commands). |
| `triggerTurn` + steer delivery | ✅ shipped | Default `true` for matches; exit always uses `deliverAs: "steer"` + `triggerTurn: true`. |
| Same-turn delivery batching | ✅ shipped | Nearby/same-turn matches coalesce via `MonitorDeliveryBatcher`; invalidated on session shutdown. |
| XML envelope for LLM context | ✅ shipped | Matches: `<pi-monitor id at>`; exits: `event="exit"` + body with path/lastLines. TUI strips envelope. |
| Compact custom tool renderers | ✅ shipped | Tools use custom TUI renderers (`renderShell: 'self'`); statusline `/m` shows active job count. |
| Interactive `/monitor-list` menu | ✅ shipped | Vertical frame, live tail (last 10 lines), details mode, confirm-or-force stop, left/right nav. |
| Sensible agent-oriented defaults | ✅ shipped | Default regex matches all lines; `before`/`after`/`debounceSeconds` default to `0`. |
| Project/global settings | ✅ shipped | `confirmStop` in `.pi/pi-monitor.json` or `~/.pi/agent/pi-monitor.json` (project overrides global). |
| License | ✅ shipped | Unlicense / public domain; not MIT like upstream’s published LICENSE. |
| No GitHub PR-watch skill | intentionally omitted | Upstream plans a `gh`-based PR watcher skill; out of scope here. |
| Fork maintenance docs | ✅ shipped | `AGENTS.md`, `CHANGELOG.md`, `RELEASE.md`, tag-driven CI publish. |

## Install

```bash
pi install npm:@clanker-code/pi-monitor
```

Local development:

```bash
pi install /path/to/pi-monitor
# or ad-hoc for one run:
pi -e ./extensions/pi-monitor.ts
```

Requires Node ≥ 22.19 and a recent pi coding agent.

## Tools

### `Monitor`

Run a shell command in the background and watch stdout for regex matches.
Matching windows and process exit are delivered automatically — **do not poll**.

```
Monitor command="tail -f /var/log/app.log" regex="error|warn" before=5 after=3
```

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `command` | yes | — | Shell command to run |
| `regex` | no | match all | Regex pattern against each stdout line |
| `regexFlags` | no | `''` | RegExp flags |
| `before` | no | `0` | Context lines before match (0–200) |
| `after` | no | `0` | Context lines after match (0–200) |
| `debounceSeconds` | no | `0` | Debounce window in seconds (0–60) |
| `label` | no | — | Human-readable label |
| `triggerTurn` | no | `true` | Wake/steer on match; `false` = display-only (exits always wake) |

### `Background`

Run a shell command in the background with **no intermediate deliveries** (exit-only).
Ids are `bg_N`. Full output is still written to a log file. **Do not poll.**

```
Background command="pnpm build" label="build"
```

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `command` | yes | — | Shell command to run |
| `label` | no | — | Human-readable label |

### Exit notification

When any job ends (natural exit, crash, or stop), the agent receives a steer message with:

- exit code (and signal if the process was killed)
- last ~8 lines of process output
- path to the full output log (`{tmpdir}/pi-monitor/{pid}/{jobID}.log`)

### `MonitorStop`

Stop a running job by id (`mon_1` or `bg_1`). You will still receive the exit notification when the process actually terminates.

### `MonitorList`

List all running monitors and background jobs (for inspection only — **do not poll** to wait for completion).

## Commands

| Command | Description |
|---------|-------------|
| `/monitor-stop <jobID>` | Stop a running monitor or background job |
| `/monitor-list` | Interactive menu: list jobs, view tail, stop |

There is **no** `/monitor` slash command — start jobs via the `Monitor` / `Background` tools.

### `/monitor-list` menu

- Lists active jobs, **newest first**
- Detail pane shows the **last 10 stdout lines** (refreshes every 1s)
- **Up/Down**: navigate · **Enter / s**: stop (confirm if `confirmStop`) · **x**: stop without confirm · **Left / Esc / q**: back/close · **Right**: Enter-equivalent on list

### Settings

Read from `<cwd>/.pi/pi-monitor.json` (project) or `~/.pi/agent/pi-monitor.json` (global); project overrides global.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `confirmStop` | boolean | `true` | Whether Enter/s asks for confirmation before stopping |

```json
{ "confirmStop": false }
```

## Security model

- Pi packages run with full system access — review the source before installing.
- Commands run in their own process group; stop is SIGTERM → grace → SIGKILL.
- Delivered process output is nonce-fenced, ANSI/control-stripped, and best-effort secret-redacted.
- Regex patterns are length-capped and ReDoS-vetted before a monitor starts.
- Full process logs on disk may contain secrets; treat log paths as sensitive.

## Development

```bash
pnpm install
pnpm test
pnpm check
```

Changelog: [CHANGELOG.md](./CHANGELOG.md). Release process: [RELEASE.md](./RELEASE.md).

## Upstream

- Original design and research: [Shodocan/pi-monitor-plugin](https://github.com/Shodocan/pi-monitor-plugin) (successor ideas also relate to [opencode-monitor-plugin](https://github.com/Shodocan/opencode-monitor-plugin)).
- We credit Walisson Casonatto for the monitor architecture (ProcessRunner, MonitorEngine, ReDoS worker, delivery hygiene). Divergences above are ours.

## License

[Unlicense](LICENSE) (public domain).
