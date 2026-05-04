import { QueryClient, QueryFunction } from "@tanstack/react-query";
import { sanitizeForChatText } from "@shared/safe-log";

// Single-redirect guard so a burst of 401s (e.g. several React Query
// hooks fire in parallel after the cookie expires) only triggers ONE
// navigation. Without this, each parallel 401 would race to set
// window.location and the URL bar would flicker. NOTE FOR CODEX: do
// NOT remove the guard — TanStack Query fans queries out aggressively,
// and this prevents a multi-second login-page flash on session expiry.
let _redirectedToLogin = false;
function maybeRedirectToLogin(): boolean {
  if (typeof window === "undefined") return false;
  if (_redirectedToLogin) return true;
  // Don't redirect if we're already on /login — would create a loop
  // when the operator clicks Sign In with a wrong password.
  if (window.location.pathname === "/login") return false;
  _redirectedToLogin = true;
  const next = window.location.pathname + window.location.search;
  window.location.href = `/login?next=${encodeURIComponent(next)}`;
  return true;
}

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    const text = sanitizeForChatText((await res.text()) || res.statusText, { maxLength: 4_000 });
    throw new Error(`${res.status}: ${text}`);
  }
}

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined,
): Promise<Response> {
  const res = await fetch(url, {
    method,
    headers: data ? { "Content-Type": "application/json" } : {},
    body: data ? JSON.stringify(data) : undefined,
    credentials: "include",
  });

  if (res.status === 401 && maybeRedirectToLogin()) {
    // Throw a sentinel so callers don't try to parse the body, but
    // the redirect already happened — error toast won't render
    // because the page is unmounting.
    throw new Error("401: redirecting to login");
  }
  await throwIfResNotOk(res);
  return res;
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    const res = await fetch(queryKey.join("/") as string, {
      credentials: "include",
    });

    if (res.status === 401) {
      // Redirect first; falling through to the legacy returnNull path
      // would silently keep the React tree alive against a dead session.
      if (maybeRedirectToLogin()) throw new Error("401: redirecting to login");
      if (unauthorizedBehavior === "returnNull") return null;
    }

    await throwIfResNotOk(res);
    return await res.json();
  };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: false,
      staleTime: Infinity,
      retry: false,
    },
    mutations: {
      retry: false,
    },
  },
});
