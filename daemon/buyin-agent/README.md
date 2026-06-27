# Buy-in agent runner (cowork buy-in engine)

The local Mac process that runs the **autonomous buy-in finder**: a Claude agent
that researches replacement rentals and attaches the chosen combo to a reservation,
replacing the legacy deterministic ladder. It is the "brain"; the existing VRBO
sidecar stays the "muscle" (the agent calls the sidecar's scrape tools, preserving
its bot-wall handling). See the full plan in
`.claude/plans/structured-herding-starfish.md`.

## Why it runs here (not on Railway)

The agent must drive **your** logged-in VRBO/Airbnb sessions from **your** home IP to
avoid bot-walls — exactly like the sidecar. It runs as a per-user launchd LaunchAgent
in your GUI session, **not** a system daemon.

## Status: Phase 0 (scaffold)

Today this runner only **polls + heartbeats** the server's agent queue and keeps the
Mac awake during a run. The agent loop (`runAgent`) and the session precheck
(`precheckSessions`) are stubs — the cowork engine still falls through to the legacy
ladder, so no run is enqueued yet. Wiring lands in Phase 2.

## Transport

- Polls `GET /api/admin/buyin-agent/next` (X-Admin-Secret).
- Heartbeats `POST /api/admin/buyin-agent/heartbeat` while holding a run.
- Reports `POST /api/admin/buyin-agent/result` with a **structured outcome**:
  `attached | no-combo-found | budget-exhausted | bot-walled | session-invalid | agent-error`
  plus the candidate set it considered (plan §5 observability).

These admin routes are allowlisted in `server/auth.ts` exactly like the sidecar's.

## Install

```sh
mkdir -p ~/.buyin-agent-daemon
cp daemon/buyin-agent/com.buyinagent.runner.plist ~/Library/LaunchAgents/
# edit the plist: NODE_BIN, RUNNER_PATH (abs path to daemon/buyin-agent/runner.mjs),
# BUYIN_AGENT_SERVER, ADMIN_SECRET, ANTHROPIC_API_KEY, __HOME__
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.buyinagent.runner.plist
launchctl kickstart -k gui/$(id -u)/com.buyinagent.runner
tail -f ~/.buyin-agent-daemon/runner.log   # expect: "starting — server=…"
```

Verify the server sees it: `GET /api/admin/buyin-agent/status` should show
`online: true` within ~90s of the runner starting.

## Env

| Var | Purpose |
| --- | --- |
| `BUYIN_AGENT_SERVER` | Deployed app base URL the runner polls (required) |
| `ADMIN_SECRET` | Same secret as the server; sent as `X-Admin-Secret` |
| `ANTHROPIC_API_KEY` | For the Claude Agent SDK loop (Phase 2) |
| `BUYIN_AGENT_MODEL` | Default `claude-opus-4-8` (the queued run's `model` hint overrides per-run) |
| `BUYIN_AGENT_POLL_IDLE_MS` | Idle poll cadence (default 5000) |
| `BUYIN_AGENT_HEARTBEAT_MS` | Heartbeat cadence while running (default 10000) |
| `BUYIN_AGENT_RUN_BUDGET_MS` | Hard wall-clock per run (default 25 min) |
| `BUYIN_AGENT_KEEP_MAC_AWAKE` | `1` (default) holds `caffeinate` during a run |
