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

Both `POST /api/assistant/chat` and `POST /api/assistant/confirm` stream these
event types (`data: {json}\n\n`):

| type | payload | meaning |
|---|---|---|
| `session` | `{sessionId}` | session created/resumed |
| `status` | `{text}` | "Thinking…" / "Working…" |
| `tool_call` | `{name,label,input}` | a tool started |
| `tool_result` | `{name,ok}` | that tool finished |
| `confirm` | `{confirmId,label,summary,input}` | a WRITE action is staged, awaiting the operator's Confirm/Cancel |
| `text` | `{text}` | final assistant answer |
| `error` | `{message}` | user-facing failure |
| `done` | — | turn complete |

## Safety model — confirm-before-act (ACTIVE)

Tools carry a `kind: "read" | "write"`. **Write tools NEVER execute inside the
agent loop.** When the model calls one, the loop stages it in `confirm.ts`
(one-shot, TTL'd, in-memory), streams a `confirm` event, and hands the model a
tool_result saying the action is *awaiting operator confirmation* — so it
describes (not claims) the action. The client renders a confirm card (label +
plain-English summary + Confirm/Cancel). Clicking Confirm POSTs
`/api/assistant/confirm`, which `takePendingAction` (one-shot — can never run
twice), executes the tool over loopback, and streams the model's outcome
summary. Cancel records the decision and runs nothing.

Write tools MUST supply `confirmLabel(input)` + `confirmSummary(input)` (enforced
by `tests/assistant-tools.test.ts`). Current write (confirm-gated) tools:
- **`start_auto_fill`** — searches + attaches the cheapest profitable buy-in combo
  to a booking (payload built server-side from `getPropertyUnits(propertyId)`,
  `expectedRevenue` passed so the $100 profit gate stays on). `check_auto_fill`
  (read) polls the job.
- **`send_guest_message`** — sends a reply into a Guesty conversation, routed to the
  guest's booking channel (reads the conversation's `module` first, like the inbox).
- **`send_payment_receipt`** — sends a payment/refund receipt for a reservation.

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
| **1 · Buy-ins & pricing (read)** | LIVE `find_buy_in` (single unit), `scan_city_vrbo` (combo finder — "find a better combination / new location"), `get_market_rates` (pricing). | **shipped** |
| **1.5 · Confirm-gated attach** | confirm gate wired end-to-end (agent intercept + `/api/assistant/confirm` + client confirm card); first write tool `start_auto_fill` + `check_auto_fill`. | **shipped** |
| **2 · Photos & listings (read)** | `find_photos` (candidate photos for a community), `get_photo_alerts` (OTA photo-change/competitor alerts), `get_photo_listing_status` (per-folder photo↔OTA dashboard). | **shipped** |
| **3 · Inbox & outward actions** | read: `list_guest_conversations`, `get_guest_thread`, `draft_guest_reply`. Confirm-gated writes: `send_guest_message`, `send_payment_receipt`. | **shipped** |
| **4 · Polish** | prompt caching (system + tools), session-history UI (list/load past chats) + new-chat, proactive nudge chips (`GET /api/assistant/nudges`). Haiku fast-router deferred (see below). | **shipped** |

### Phase 4 notes

- **Prompt caching** (`server/assistant/prompt-cache.ts`) marks the system prompt
  + the last tool def with `cache_control: ephemeral`, so the large system + 17
  tool defs are cached across turns within a session (~5min TTL). Off via
  `ASSISTANT_PROMPT_CACHE=0`. Cuts input-token cost/latency on multi-turn chats.
- **Session history**: the dock header has a history button (lists past chats via
  `GET /api/assistant/sessions`, loads one via `GET /api/assistant/sessions/:id`)
  and a new-chat button. Loaded chats replay user/assistant text + tool chips.
- **Proactive nudges**: `GET /api/assistant/nudges` returns starter suggestion
  chips for the empty dock — dynamic where cheap (unacknowledged photo-alert count
  via a tight-timeout loopback call, fail-soft) plus static helpers. Clicking a
  chip sends that prompt.
- **Haiku fast-router — deferred (intentional).** A cheap-model router for trivial
  lookups adds an extra classification call + mis-routing risk, and its main win
  (cost/latency) is largely captured by prompt caching. The model stays
  configurable via `ASSISTANT_MODEL`; revisit a router only if cost data warrants.

**Note on `start_auto_fill` verification:** the auto-fill/attach path drives the
live browser sidecar and commits buy-ins, so it can't be fully exercised from the
cloud dev session (no DB, no sidecar). The confirm-gate plumbing + payload
construction are unit-tested and code-path verified; the live attach should be
smoke-tested on Railway with the sidecar online before relying on it.

## Files

- `server/assistant/tools.ts` — tool registry (read + write tools → loopback).
- `server/assistant/agent.ts` — Claude tool_use loop + SSE + confirm intercept + `runConfirmedAction`.
- `server/assistant/store.ts` — chat persistence (fail-soft).
- `server/assistant/confirm.ts` — confirm-before-act pending-action store (one-shot, TTL'd).
- `server/assistant/prompt-cache.ts` — pure prompt-caching helpers (system + tools).
- `server/assistant/routes.ts` — `registerAssistantRoutes(app)`; SSE chat / confirm / history.
- `client/src/components/AssistantDock.tsx` — floating dock, SSE consumer + confirm card.
- `shared/schema.ts` — `assistantSessions` / `assistantMessages`.
- `tests/assistant-tools.test.ts` — registry shape, write-tool confirm contract, dispatch.

## Enabling it

1. Set `PLATFORM_ASSISTANT_ENABLED=1` and `ANTHROPIC_API_KEY` in Railway.
2. Redeploy (tables auto-create). The indigo chat bubble appears bottom-right of
   the dashboard for the admin operator.
