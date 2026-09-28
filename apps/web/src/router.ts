import { useCallback, useEffect, useState } from "react";

export type PortalRoute =
  | "workspaces"
  | "admin-users"
  | "admin-workers"
  | "admin-audit"
  | "not-found";

export const ROUTE_PATHS: Record<Exclude<PortalRoute, "not-found">, string> = {
  workspaces: "/",
  "admin-users": "/admin/users",
  "admin-workers": "/admin/workers",
  "admin-audit": "/admin/audit",
};

export function routeFromPathname(pathname: string): PortalRoute {
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  const match = Object.entries(ROUTE_PATHS).find(([, path]) => path === normalized);
  return (match?.[0] as PortalRoute | undefined) ?? "not-found";
}

export function isAdminRoute(route: PortalRoute): boolean {
  return route.startsWith("admin-");
}

export function canAccessRoute(route: PortalRoute, role: "user" | "admin"): boolean {
  return !isAdminRoute(route) || role === "admin";
}

function currentPathname(): string {
  return typeof window === "undefined" ? "/" : window.location.pathname;
}

export function usePortalRouter() {
  const [pathname, setPathname] = useState(currentPathname);

  useEffect(() => {
    const handlePopState = () => setPathname(window.location.pathname);
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  const navigate = useCallback((path: string) => {
    if (window.location.pathname === path) return;
    window.history.pushState(null, "", path);
    setPathname(path);
  }, []);

  return { route: routeFromPathname(pathname), navigate };
}
