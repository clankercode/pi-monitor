# Changelog

All notable changes to [`@clanker-code/pi-monitor`](https://www.npmjs.com/package/@clanker-code/pi-monitor) are documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-08-02

### Added

- **`Background` tool** — fire-and-forget shell jobs (`bg_N` ids) with **no intermediate deliveries**; only exit is reported.
- **Exit notifications** — when any job ends (natural exit, crash, or stop), the agent is steered with:
  - exit code and signal (if killed)
  - last ~8 lines of process output (`EXIT_TAIL_LINES`)
  - path to the full output log
- **Full output logs** — every job tees stdout/stderr (stream-tagged) to  
  `{tmpdir}/pi-monitor/{pid}/{jobID}.log`. Path is returned on start and exit; logs survive dispose.
- **No-poll contract** — tool descriptions, start messages, and exit envelopes tell agents not to poll; matches and exits are push-delivered.
- **Exit XML envelope** — `formatMonitorExitXml` with `event="exit"`, exit metadata, and fenced last lines.
- **ProcessRunner** — `ProcessExitResult` (`code` + `signal`), per-session log dir, `outputPath` / `tailCombined`, async dispose (SIGTERM without blocking).
- **Shared job registry** — monitors and background jobs share `MAX_ACTIVE_JOBS` (20); start rejects when the limit is reached.
- **UI** — Background tool call/result renderers; list/stop/statusline treat `mon_*` and `bg_*` as jobs.
- **Docs** — README / AGENTS.md cover Background, exit notifications, log paths, and no-poll guidance; fork divergences table updated.

### Changed

- **Monitor defaults** (already agent-oriented; documented consistently): optional regex (default match-all), `before`/`after`/`debounceSeconds` default `0`, `triggerTurn` default `true`.
- **Match `triggerTurn: false`** still gets **exit** steers (exits always wake).
- **Session safety** — exit steers and match deliveries from a prior session are not delivered into a restarted session.
- **Stdout-only matching** — stderr is logged to the full output file but does not participate in regex match deliveries.
- **ReDoS timeout** — worker timeout raised to 500ms under parallel load (still within agent UX budget).

### Fixed

- **Stale extension ctx crash** — deferred match flushes and exit steers no longer throw
  uncaught when `pi.sendMessage` is called after session replacement/reload (`assertActive`).
  `MonitorDeliveryBatcher.flush` re-checks invalidation per group, swallows send failures,
  and auto-invalidates; exit notifications use a safe send wrapper.
- Jobs disappearing from the list without an agent-visible signal when the process exited (exit notification closes that gap).

## [0.1.1] - 2026-07-27

First tagged release of **`@clanker-code/pi-monitor`** (npm scope `@clanker-code`; GitHub org `clankercode`).

### Added

- **`Monitor` tool** — run a shell command, match stdout lines with regex, deliver before/after context windows.
- **`MonitorStop` / `MonitorList` tools** — AI-callable stop and list (not only slash commands).
- **`/monitor-stop` / `/monitor-list`** — human commands; interactive list TUI (vertical frame, live tail, details mode, confirm-or-force stop, left/right nav).
- **`triggerTurn` (default `true`)** — matching output delivered as `deliverAs: "steer"` with `triggerTurn: true`; set `false` for display-only logging.
- **Same-turn delivery batching** — `MonitorDeliveryBatcher` coalesces nearby deliveries; invalidated on session shutdown so stale steers never fire.
- **XML envelope** — match deliveries wrapped as `<pi-monitor id="…" at="…">…</pi-monitor>` for LLM context; TUI strips the envelope.
- **Security / hygiene** — ReDoS vetting (batched worker + cache + trivial fast-path), nonce-fencing of untrusted output, secret redaction, ANSI stripping.
- **Compact custom tool renderers** — `renderShell: 'self'` for Monitor / MonitorStop / MonitorList; compact message renderer for delivered matches; statusline `/m` active count.
- **Agent-oriented defaults** — regex defaults to match-all; `before` / `after` / `debounceSeconds` default to `0`.
- **Settings** — `confirmStop` in project `.pi/pi-monitor.json` or global `~/.pi/agent/pi-monitor.json`.
- **CI / release** — gate on push/PR; tag-driven npm publish (OIDC trusted publishing) + GitHub Release; `RELEASE.md` and `just release`.
- **Docs** — fork attribution and divergences table vs [pi-monitor-plugin](https://github.com/Shodocan/pi-monitor-plugin); npm vs GitHub naming clarified; `AGENTS.md` agent surface.

### Changed

- Package renamed/prepared for publish as `@clanker-code/pi-monitor` (from local `pi-monitor` identity).
- License: Unlicense / public domain (not MIT like upstream’s published LICENSE).

### Notes

- Monitor-only scope relative to upstream’s planned jobs suite (background / loop / schedule were not shipped in this release).
- Upstream PR-watch skill intentionally omitted.

## [0.1.0] - 2026-07-27

Package identity and first-publish scaffolding as `@clanker-code/pi-monitor` `0.1.0` (see `RELEASE.md`). Feature work that landed under this version line is summarized under [0.1.1](#011---2026-07-27); `0.1.1` is the first `v*` tag.

[Unreleased]: https://github.com/clankercode/pi-monitor/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/clankercode/pi-monitor/releases/tag/v0.2.0
[0.1.1]: https://github.com/clankercode/pi-monitor/releases/tag/v0.1.1
[0.1.0]: https://github.com/clankercode/pi-monitor/commits/master
