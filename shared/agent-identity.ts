// Identity of the remote "agent" portal user.
//
// The agent login (role "agent") is operated by Christal. Every credential that
// resolves to role "agent" — the shared `agent`/`agent` login AND the personal
// `christalh` login (see server/auth.ts resolveLoginRole) — is Christal, so this
// personalization is keyed off the ROLE, not the username (the auth cookie only
// carries the role). One source of truth shared by the server (guest-reply
// sign-off in the AI draft) and the client (login greeting + header chip) so the
// two never drift.
//
// If a second, differently-named agent is ever added, this becomes a per-user
// lookup instead of a constant — but today there is exactly one agent persona.

export const AGENT_DISPLAY_NAME = "Christal";

/** Shown as the post-login greeting (welcome toast + header). */
export const AGENT_LOGIN_GREETING = `Aloha ${AGENT_DISPLAY_NAME}`;

/**
 * The name the agent's guest replies are signed with, replacing the operator
 * persona ("John Carpenter") in the AI-draft signature. The sign-off WORD stays
 * region-aware upstream (Hawaii → "Mahalo,", mainland → "Thank You,"), so a
 * Hawaii reply signs "Mahalo, Christal".
 */
export const AGENT_REPLY_SIGNOFF_NAME = AGENT_DISPLAY_NAME;
