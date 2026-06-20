import { guestyRequest } from "./guesty-sync";
import {
  buildOtaSendModuleAttempts,
  guestyChannelLabel,
  guestyModuleTypeLooksOta,
  mergeOtaModuleFromReservation,
  otaChannelRequested,
  parseGuestyConversationModule,
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

async function fetchRecentConversationPosts(conversationId: string): Promise<Record<string, unknown>[]> {
  const postsData = await guestyRequest(
    "GET",
    `/communication/conversations/${encodeURIComponent(conversationId)}/posts?limit=15`,
  );
  return unwrapPosts(postsData);
}

async function waitForVerifiedHostPost(
  conversationId: string,
  body: string,
  requireOtaModule: boolean,
  logPrefix: string,
): Promise<ReturnType<typeof verifyOtaHostPostDelivered>> {
  const delaysMs = [0, 800, 1600, 2400];
  let last: ReturnType<typeof verifyOtaHostPostDelivered> = { verified: false, reason: "No matching host post found on the conversation after send" };
  for (const delay of delaysMs) {
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    const posts = await fetchRecentConversationPosts(conversationId);
    last = verifyOtaHostPostDelivered(posts, body, requireOtaModule);
    if (last.verified) return last;
  }
  console.warn(`[${logPrefix}] post-send verification still pending after ${delaysMs.length} polls`);
  return last;
}

export async function sendGuestyConversationMessage(args: {
  conversationId: string;
  body: string;
  module: Record<string, unknown>;
  reservation?: Record<string, unknown> | null;
  channelHint?: string | null;
  logPrefix?: string;
}): Promise<{ deliveredVia: string; deliveryModuleType?: string; verified: boolean }> {
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

  let lastErr: unknown = null;
  let lastVerify: ReturnType<typeof verifyOtaHostPostDelivered> | null = null;

  for (const attempt of attempts) {
    try {
      await send(attempt);
      const verification = await waitForVerifiedHostPost(conversationId, body, requireOta, logPrefix);
      if (verification.verified) {
        return {
          deliveredVia: guestyChannelLabel(attempt),
          deliveryModuleType: verification.deliveryModuleType,
          verified: true,
        };
      }
      lastVerify = verification;
      console.warn(
        `[${logPrefix}] Guesty accepted send with module ${JSON.stringify(attempt)} but verification failed:`,
        verification.reason,
      );
    } catch (sendErr: unknown) {
      lastErr = sendErr;
    }
  }

  if (requireOta) {
    const verifyMsg = lastVerify?.reason ?? "OTA delivery could not be verified";
    const errMsg = lastErr instanceof Error ? lastErr.message : String(lastErr ?? verifyMsg);
    throw new Error(
      `Could not deliver through ${guestyChannelLabel(module)}: ${errMsg}. ${verifyMsg}. Message was not sent via email.`,
    );
  }
  if (lastErr) throw lastErr;
  throw new Error(lastVerify?.reason ?? "Send failed");
}
