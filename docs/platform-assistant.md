# Platform AI Assistant ("Magical") — design + rollout

A persistent chat box on the dashboard that the operator can talk to in plain
language to run the whole platform:

- *"Find a better combination for the Poipu Kai booking next month."*
- *"Find photos for the new Princeville unit."*
- *"What should I charge for Kaha Lani over Thanksgiving?"*
- *"Show me every booking losing money right now."*

It is **not** a new feature silo — it is a conversational front door to the
~363 endpoints the platform already exposes. Its power comes from *orchestrating
existing functionality as tools*, never re-implementing it.

## Architecture

```
Dashboard <AssistantDock/>  ──POST /api/assistant/chat (SSE)──►  server/assistant/
  - message list                                                   agent.ts  (Claude tool_use loop)
  - tool-activity chips                                            tools.ts  (registry → loopback calls)
  - streamed answer                                                store.ts  (chat_sessions/messages)
                                                                   routes.ts (SSE + history)
                                                                       │ loopback 127.0.0.1:${PORT}
                                                                       ▼
                                                            existing endpoints (unchanged)
```

**Core principle — the agent never touches the DB / Guesty / VRBO directly.**
Every tool is a thin wrapper that calls an existing HTTP endpoint over an
in-process loopback self-call (`http://127.0.0.1:${PORT}` + `loopbackRequestHeaders()`,
which bypasses the `ADMIN_SECRET` gate via the `isLoopback` socket check — the
exact pattern `server/auto-fill-job.ts` uses). Because the agent can only act
through those endpoints, it **inherits every load-bearing rule for free**: VRBO
sight+click policy, the $100 profit gate, geo guards, no-double-attach, etc. It
physically cannot route around them.

## Why this is low-risk in this codebase

1. **The tool_use loop already exists in production** — `server/auto-reply.ts`
   (`draftReplyWithClaude`) runs a Claude `tool_use` loop with a tool registry,
   a `MAX_TURNS` cap, and tool-result feeding. The assistant generalizes it.
2. **Heavy work is already server-side + job-based** (auto-fill, expansion,
   photo fetch, pricing refresh) with `POST start → GET :jobId poll` shapes the
   assistant can drive over loopback.
3. **One consistent AI call style** — raw `fetch` to `api.anthropic.com/v1/messages`
   with `anthropic-version: 2023-06-01`. No SDK added; new code matches existing.

## Models

- **Orchestrator: `claude-opus-4-8`** (env `ASSISTANT_MODEL`) — mapping fuzzy
  asks to the right tool chain and reading the economics is the hard part.
- Later: a `claude-haiku-4-5` fast-router for trivial lookups; `claude-sonnet-4-6`
  for any vision tool (reused from `photo-community-check.ts`).

## Streaming protocol

`POST /api/assistant/chat` streams Server-Sent-Events over the POST response
body (the client reads it with `fetch` — `EventSource` is GET-only). Event
types (`data: {json}\n\n`):

| type | payload | meaning |
|---|---|---|
| `session` | `{sessionId}` | session created/resumed |
| `status` | `{text}` | "Thinking…" / "Working…" |
| `tool_call` | `{name,label,input}` | a tool started |
| `tool_result` | `{name,ok}` | that tool finished |
| `text` | `{text}` | final assistant answer |
| `error` | `{message}` | user-facing failure |
| `done` | — | turn complete |

## Safety model — confirm-before-act (planned for write tools)

Tools carry a `kind: "read" | "write"`. **Phase 0 ships read-only tools only.**
When write/outward tools land (attach buy-in, send guest message, reprice,
publish), they will NOT execute directly: the agent will emit a confirm card
(plain-English summary + exact payload + Confirm/Cancel) and only run the
endpoint on explicit operator confirm. The `kind` tag exists now so that gate is
a one-line check (`if (tool.kind === "write") …`) in `agent.ts`.

## Persistence

- `assistant_sessions` — one row per chat thread (title, createdBy, timestamps).
- `assistant_messages` — one row per turn (role, JSON `content` = text + tool
  call/result audit). Gives durable scrollback + an audit trail.

Both auto-create on boot via `server/schema-maintenance.ts` (`CREATE TABLE IF
NOT EXISTS`) **and** `db:push`. All store helpers are fail-soft (return
empty/null on DB error) so the chat never 500s the dashboard.

## Rollout (feature-flagged)

Everything is dark unless **`PLATFORM_ASSISTANT_ENABLED=1`** (and
`ANTHROPIC_API_KEY` set). The client polls `GET /api/assistant/status` and only
renders the dock for the **admin** role when enabled.

| Phase | Scope | Status |
|---|---|---|
| **0 · Skeleton** | SSE chat + dock + read tools: `get_dashboard`, `list_bookings`, `get_reports`, `get_buy_in_estimate` | **shipped** |
| **1 · Buy-ins & pricing (read)** | LIVE `find_buy_in` (single unit), `scan_city_vrbo` (combo finder — "find a better combination / new location"), `get_market_rates` (pricing). Confirm-gate **store** (`confirm.ts`) landed; gated **attach/auto-fill** deferred (see below). | **shipped (read tools)** |
| 1.5 · Confirm-gated attach | wire `confirm.ts` into the agent loop + a `/confirm` endpoint + client confirm card; first write tool = attach a found combo to a booking | next |
| 2 · Photos & listings | `find_photos`, `check_photo_community`, `build_listing`, photo audit | planned |
| 3 · Inbox & outward actions | guest threads, drafting, confirm-gated sends/relocation | planned |
| 4 · Polish | Haiku fast-router, prompt caching, session history UI, proactive nudges | planned |

**Why the gated attach was split into Phase 1.5:** the auto-fill/attach path takes
a large reservation-slot-specific payload (per-slot `unitId`/`bedrooms`) and
drives the live browser sidecar, so it can't be exercised from the cloud dev
session (no DB, no sidecar). It deserves a focused increment with live
verification rather than shipping unverified on the money path. The read tools
already deliver the headline "find a better combination / new location / pricing"
value safely; `confirm.ts` is in place so the gate is ready to wire.

## Files

- `server/assistant/tools.ts` — tool registry (read tools → loopback).
- `server/assistant/agent.ts` — Claude tool_use loop + SSE event emission.
- `server/assistant/store.ts` — chat persistence (fail-soft).
- `server/assistant/confirm.ts` — confirm-before-act pending-action store (write tools).
- `server/assistant/routes.ts` — `registerAssistantRoutes(app)`; SSE chat + history.
- `client/src/components/AssistantDock.tsx` — floating dock, SSE consumer.
- `shared/schema.ts` — `assistantSessions` / `assistantMessages`.
- `tests/assistant-tools.test.ts` — registry shape + dispatch.

## Enabling it

1. Set `PLATFORM_ASSISTANT_ENABLED=1` and `ANTHROPIC_API_KEY` in Railway.
2. Redeploy (tables auto-create). The indigo chat bubble appears bottom-right of
   the dashboard for the admin operator.
