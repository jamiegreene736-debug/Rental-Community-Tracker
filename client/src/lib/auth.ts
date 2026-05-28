import { useQuery } from "@tanstack/react-query";

export type PortalRole = "admin" | "agent";

export type PortalSession = {
  authenticated: boolean;
  role: PortalRole;
  username: string;
};

export function usePortalSession() {
  return useQuery<PortalSession>({
    queryKey: ["/api/auth/session"],
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
}
