import { guestyRequest } from "./guesty-sync";
import {
  bodiesAreDuplicate,
  buildOtaSendModuleAttempts,
  guestyChannelLabel,
  guestyModuleTypeLooksOta,
  isHostConversationPost,
  mergeOtaModuleFromReservation,
  otaChannelRequested,
  parseGuestyConversationModule,
  postBodyText,
  postDeliveryState,
  postTimestamp,
  verifyOtaHostPostDelivered,
} from "@shared/guesty-ota-send";

export {
  buildOtaSendModuleAttempts,
  guestyChannelLabel,
  guestyModuleTypeLooksOta,
  guestySendMessageModule,
  mergeOtaModuleFromReservation,
  otaModuleTypeFromReservation,
  parseGuestyConversationModule,
  verifyOtaHostPostDelivered,
} from "@shared/guesty-ota-send";

function unwrapPosts(data: unknown): Record<string, unknown>[] {
  const d = data as Record<string, unknown> | null | undefined;
  const nested = d?.data as Record<string, unknown> | undefined;
  const rows = nested?.posts ?? d?.posts ?? d?.results;
  return Array.isArray(rows) ? rows as Record<string, unknown>[] : [];
}

async function moduleFromConversationPosts(conversationId: string): Promise<Record<string, unknown> | null> {
  try {
    const postsData = await guestyRequest(
      "GET",
      `/communication/conversations/${encodeURIComponent(conversationId)}/posts?limit=30`,
    );
    const posts = unwrapPosts(postsData);
    for (const post of [...posts].reverse()) {
      const mod = post?.module;
      if (mod && typeof mod === "object" && guestyModuleTypeLooksOta(String((mod as Record<string, unknown>).type ?? ""))) {
        return parseGuestyConversationModule(mod);
      }
    }
    for (const post of [...posts].reverse()) {
      if (post?.module && typeof post.module === "object") {
        return parseGuestyConversationModule(post.module);
      }
    }
  } catch (postsErr: unknown) {
    const msg = postsErr instanceof Error ? postsErr.message : String(postsErr);
    console.warn("[guesty-ota-messaging] posts module lookup failed:", msg);
  }
  return null;
}

async function finalizeGuestyConversationModule(
  conversationId: string,
  rawModule: Record<string, unknown> | null | undefined,
  reservation: Record<string, unknown> | null,
  channelHint?: string | null,
): Promise<Record<string, unknown>> {
  let module = parseGuestyConversationModule(rawModule ?? {});
  const type = String(module.type ?? "").toLowerCase();
  const missingChannelId = module.channelId === undefined || module.channelId === null || module.channelId === "";

  if (!guestyModuleTypeLooksOta(type) || missingChannelId) {
    const postsModule = await moduleFromConversationPosts(conversationId);
    if (postsModule) {
      const postsType = String(postsModule.type ?? "").toLowerCase();
      if (guestyModuleTypeLooksOta(postsType) || (!guestyModuleTypeLooksOta(type) && postsType !== "email")) {
        module = postsModule;
      }
    }
  }

  return mergeOtaModuleFromReservation(module, reservation, channelHint);
}

export async function findGuestyConversationForReservation(
  reservationId: string,
  channelHint?: string | null,
): Promise<{ id: string; module: Record<string, unknown>; reservation: Record<string, unknown> | null } | null> {
  const rid = String(reservationId ?? "").trim();
  if (!rid) return null;

  const reservation = await guestyRequest(
    "GET",
    `/reservations/${encodeURIComponent(rid)}?fields=${encodeURIComponent("conversationId conversation integration source")}`,
  ).catch(() => null) as Record<string, unknown> | null;

  let conversationId = "";
  let rawModule: Record<string, unknown> | null = null;

  try {
    const data = await guestyRequest(
      "GET",
      `/communication/conversations?reservationId=${encodeURIComponent(rid)}&limit=1&fields=`,
    ) as Record<string, unknown>;
    const nested = data?.data as Record<string, unknown> | undefined;
    const rows = nested?.conversations ?? data?.conversations ?? data?.results;
    if (Array.isArray(rows) && rows.length > 0) {
      const c = rows[0] as Record<string, unknown>;
      conversationId = String(c?._id ?? c?.id ?? "").trim();
      const lastPost = c?.lastPost as Record<string, unknown> | undefined;
      const lastMessage = c?.lastMessage as Record<string, unknown> | undefined;
      rawModule = (c?.module ?? lastPost?.module ?? lastMessage?.module) as Record<string, unknown> | null;
    }
  } catch (searchErr: unknown) {
    const msg = searchErr instanceof Error ? searchErr.message : String(searchErr);
    console.warn("[guesty-ota-messaging] conversation search failed, falling back to reservation doc:", msg);
  }

  if (!conversationId && reservation) {
    conversationId = String(
      reservation?.conversationId
      ?? (reservation?.conversation as Record<string, unknown> | undefined)?._id
      ?? (reservation?.conversation as Record<string, unknown> | undefined)?.id
      ?? "",
    ).trim();
  }
  if (!conversationId) return null;

  if (!rawModule || !guestyModuleTypeLooksOta(String(parseGuestyConversationModule(rawModule).type ?? ""))) {
    try {
      const conv = await guestyRequest(
        "GET",
        `/communication/conversations/${encodeURIComponent(conversationId)}?fields=${encodeURIComponent("module")}`,
      ) as Record<string, unknown>;
      if (conv?.module) rawModule = conv.module as Record<string, unknown>;
    } catch {
      /* posts fallback inside finalize */
    }
  }

  const module = reservation
    ? await finalizeGuestyConversationModule(conversationId, rawModule, reservation, channelHint)
    : parseGuestyConversationModule(rawModule ?? {});

  return { id: conversationId, module, reservation };
}

/**
 * Resolve {module, reservation} for a conversation we already have the id of
 * (the Guest Inbox), so an inbox reply goes through the SAME hardened, delivery-
 * verified send path as Message AD instead of a client-direct /send-message that
 * trusts HTTP 200. The OTA module is derived from the reservation's
 * integration.platform (the proven-delivering type) + conversation posts.
 */
export async function findGuestyConversationById(
  conversationId: string,
  reservationId?: string | null,
  channelHint?: string | null,
): Promise<{ id: string; module: Record<string, unknown>; reservation: Record<string, unknown> | null } | null> {
  const cid = String(conversationId ?? "").trim();
  if (!cid) return null;

  let reservation: Record<string, unknown> | null = null;
  const rid = String(reservationId ?? "").trim();
  if (rid) {
    reservation = await guestyRequest(
      "GET",
      `/reservations/${encodeURIComponent(rid)}?fields=${encodeURIComponent("conversationId conversation integration source")}`,
    ).catch(() => null) as Record<string, unknown> | null;
  }

  let rawModule: Record<string, unknown> | null = null;
  try {
    const conv = await guestyRequest(
      "GET",
      `/communication/conversations/${encodeURIComponent(cid)}?fields=${encodeURIComponent("module")}`,
    ) as Record<string, unknown>;
    if (conv?.module) rawModule = conv.module as Record<string, unknown>;
  } catch {
    /* posts fallback inside finalize */
  }

  const module = await finalizeGuestyConversationModule(cid, rawModule, reservation, channelHint);

  // If we couldn't load a reservation but the resolved module IS an OTA channel,
  // synthesize a platform hint from it so the send LEADS with the proven type
  // (otherwise buildOtaSendModuleAttempts defaults Booking.com to bookingCom2
  // first — the live integration.platform is bookingCom, not bookingCom2).
  if (!reservation) {
    const t = String(module.type ?? "");
    if (guestyModuleTypeLooksOta(t)) {
      reservation = { integration: { platform: t }, source: t };
    }
  }

  return { id: cid, module, reservation };
}

async function fetchRecentConversationPosts(conversationId: string): Promise<Record<string, unknown>[]> {
  // limit=25 so a delivered synced copy isn't pushed past the verifier's scan
  // window by a run of pending duplicates on a busy thread.
  const postsData = await guestyRequest(
    "GET",
    `/communication/conversations/${encodeURIComponent(conversationId)}/posts?limit=25`,
  );
  return unwrapPosts(postsData);
}

// OTA delivery confirmation is ASYNC: Guesty posts the message, then the channel
// (Booking.com/Airbnb/VRBO) accepts it and Guesty stamps module.externalId /
// flips status to completed. Live timing (2026-06-20) showed the Booking.com
// confirmation landing ~30s after send — far past the old ~5s window, which made
// every real Booking.com delivery look "unverified" and drove duplicate resends.
// Poll up to ~38s, leaving headroom under the 55s send route budget for the
// pre-check fetch + the POST + per-poll overhead (so the route returns a real
// result instead of a 504). Tunable via env.
const VERIFY_DEADLINE_MS = Math.max(5_000, Number(process.env.GUESTY_OTA_VERIFY_DEADLINE_MS ?? 38_000));
const VERIFY_INTERVAL_MS = Math.max(1_000, Number(process.env.GUESTY_OTA_VERIFY_INTERVAL_MS ?? 3_000));

async function waitForVerifiedHostPost(
  conversationId: string,
  body: string,
  requireOtaModule: boolean,
  logPrefix: string,
): Promise<ReturnType<typeof verifyOtaHostPostDelivered>> {
  const start = Date.now();
  let last: ReturnType<typeof verifyOtaHostPostDelivered> = { verified: false, reason: "No matching host post found on the conversation after send" };
  let first = true;
  while (true) {
    if (!first) await new Promise((resolve) => setTimeout(resolve, VERIFY_INTERVAL_MS));
    first = false;
    const posts = await fetchRecentConversationPosts(conversationId);
    last = verifyOtaHostPostDelivered(posts, body, requireOtaModule);
    if (last.verified) return last;
    // A definitive wrong-channel misroute (our message was filed on a non-OTA
    // channel, e.g. email) is terminal — don't burn the full window waiting for
    // an OTA confirmation that will never come.
    if (last.pending === false) return last;
    if (Date.now() - start >= VERIFY_DEADLINE_MS) break;
  }
  console.warn(
    `[${logPrefix}] OTA delivery still unconfirmed after ${Math.round((Date.now() - start) / 1000)}s (pending=${last.pending === true}): ${last.reason ?? ""}`,
  );
  return last;
}

// If this exact message is already on the thread we should NOT send a duplicate.
// Returns "delivered" (channel confirmed — idempotent success), "pending" (a
// prior send is still in flight within the resume window — resume polling, don't
// resend), or null (nothing matching/recent — safe to send).
const RESUME_PENDING_WINDOW_MS = Math.max(0, Number(process.env.GUESTY_OTA_RESUME_PENDING_MS ?? 240_000));

function classifyExistingSend(
  posts: Record<string, unknown>[],
  body: string,
  requireOtaModule: boolean,
): { state: "delivered"; deliveryModuleType?: string } | { state: "pending" } | null {
  const now = Date.now();
  let pendingMatch = false;
  for (const post of posts) {
    if (!isHostConversationPost(post)) continue;
    if (!bodiesAreDuplicate(body, postBodyText(post as { body?: unknown; text?: unknown; message?: unknown }))) continue;
    const modType = String((post.module as Record<string, unknown> | undefined)?.type ?? "").toLowerCase();
    // A copy on a different (e.g. email) channel doesn't count as already-sent
    // to the OTA channel — let the real send proceed.
    if (requireOtaModule && !guestyModuleTypeLooksOta(modType)) continue;
    const state = postDeliveryState(post);
    if (state === "delivered") return { state: "delivered", deliveryModuleType: modType || undefined };
    if (state === "pending" && RESUME_PENDING_WINDOW_MS > 0) {
      const ts = postTimestamp(post);
      if (ts > 0 && now - ts <= RESUME_PENDING_WINDOW_MS) pendingMatch = true;
    }
  }
  return pendingMatch ? { state: "pending" } : null;
}

export async function sendGuestyConversationMessage(args: {
  conversationId: string;
  body: string;
  module: Record<string, unknown>;
  reservation?: Record<string, unknown> | null;
  channelHint?: string | null;
  logPrefix?: string;
}): Promise<{ deliveredVia: string; deliveryModuleType?: string; verified: boolean; pending?: boolean; reason?: string }> {
  const {
    conversationId,
    body,
    module,
    reservation = null,
    channelHint,
    logPrefix = "guesty-ota-messaging",
  } = args;

  const requireOta = otaChannelRequested(module, channelHint);
  const attempts = buildOtaSendModuleAttempts(module, reservation, channelHint);
  const send = (mod: Record<string, unknown>) =>
    guestyRequest("POST", `/communication/conversations/${encodeURIComponent(conversationId)}/send-message`, {
      body,
      module: mod,
    });

  // Idempotency / anti-duplicate: if this exact message is already delivered on
  // the thread (operator re-clicked, or a prior send confirmed late) reuse it; if
  // a prior identical send is still pending within the resume window, resume
  // polling instead of posting a duplicate. This is what stops the stuck-pending
  // pile-up (4 identical Booking.com copies were observed live before this fix).
  let postedModule: Record<string, unknown> = attempts[0] ?? guestySendMessageModuleSafe(module);
  let skipSend = false;
  try {
    const existing = await fetchRecentConversationPosts(conversationId);
    const prior = classifyExistingSend(existing, body, requireOta);
    if (prior?.state === "delivered") {
      return { deliveredVia: guestyChannelLabel(postedModule), deliveryModuleType: prior.deliveryModuleType, verified: true };
    }
    if (prior?.state === "pending") {
      console.warn(`[${logPrefix}] identical message already pending on ${conversationId} — resuming polling, not resending`);
      skipSend = true;
    }
  } catch (preErr: unknown) {
    // best-effort pre-check; fall through to a normal send
    console.warn(`[${logPrefix}] pre-send dedup check failed:`, preErr instanceof Error ? preErr.message : String(preErr));
  }

  // Send ONCE. Only advance to the next module if the POST itself is rejected by
  // Guesty — NEVER merely because delivery is not yet confirmed (that path posted
  // a fresh guest message on every verification miss → duplicates).
  let posted = skipSend;
  let lastErr: unknown = null;
  if (!skipSend) {
    for (const attempt of attempts) {
      try {
        await send(attempt);
        postedModule = attempt;
        posted = true;
        break;
      } catch (sendErr: unknown) {
        lastErr = sendErr;
      }
    }
  }
  if (!posted) {
    if (lastErr) throw lastErr;
    throw new Error(`Guesty rejected every send-message module for ${guestyChannelLabel(module)}`);
  }

  // Non-OTA channels (email / direct) have NO async OTA portal to confirm
  // against — Guesty's accepted POST IS the send. Polling for an externalId would
  // just block the full window and can FALSE-FAIL a delivered email (e.g. when
  // the body is wrapped and the strict matcher misses our own post). Trust the
  // 200, matching the pre-hardening behavior. Only OTA sends get the
  // delivery-verified treatment.
  if (!requireOta) {
    return { deliveredVia: guestyChannelLabel(postedModule), verified: true };
  }

  const verification = await waitForVerifiedHostPost(conversationId, body, requireOta, logPrefix);
  if (verification.verified) {
    return { deliveredVia: guestyChannelLabel(postedModule), deliveryModuleType: verification.deliveryModuleType, verified: true };
  }

  // Posted to Guesty but the channel has not confirmed delivery within the
  // window. Report honestly as `pending` rather than throwing — the old throw
  // made the operator resend and pile up duplicate pending messages. The caller
  // surfaces a "queued, not yet confirmed — don't resend" notice.
  console.warn(
    `[${logPrefix}] posted via ${guestyChannelLabel(postedModule)} but ${guestyChannelLabel(module)} delivery unconfirmed: ${verification.reason ?? ""}`,
  );
  return {
    deliveredVia: guestyChannelLabel(postedModule),
    deliveryModuleType: verification.deliveryModuleType,
    verified: false,
    // Only TRUE when the channel genuinely queued our message but hasn't
    // confirmed. A wrong-channel misroute (e.g. filed on email) sets
    // pending:false so the caller treats it as a hard non-delivery, not "queued".
    pending: verification.pending === true,
    reason: verification.reason
      ?? `${guestyChannelLabel(module)} has not confirmed delivery yet`,
  };
}

function guestySendMessageModuleSafe(module: Record<string, unknown>): Record<string, unknown> {
  const type = String(module?.type ?? "").trim();
  return type ? { type } : { type: "email" };
}
