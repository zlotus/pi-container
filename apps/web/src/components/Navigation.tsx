import type { MouseEvent } from "react";

import { ROUTE_PATHS, type PortalRoute } from "../router.js";

interface NavigationProps {
  route: PortalRoute;
  role: "user" | "admin";
  onNavigate: (path: string) => void;
}

const ITEMS: Array<{
  route: Exclude<PortalRoute, "not-found">;
  label: string;
  adminOnly?: boolean;
  userOnly?: boolean;
}> = [
  { route: "workspaces", label: "Workspace" },
  { route: "activity", label: "活动", userOnly: true },
  { route: "admin-users", label: "用户", adminOnly: true },
  { route: "admin-workspaces", label: "全部 Workspace", adminOnly: true },
  { route: "admin-workers", label: "Worker", adminOnly: true },
  { route: "admin-audit", label: "审计", adminOnly: true },
];

export function Navigation({ route, role, onNavigate }: NavigationProps) {
  function follow(event: MouseEvent<HTMLAnchorElement>, path: string) {
    if (
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) return;
    event.preventDefault();
    onNavigate(path);
  }

  return (
    <nav aria-label="Portal navigation">
      {ITEMS.filter((item) =>
        (!item.adminOnly || role === "admin") && (!item.userOnly || role === "user")
      ).map((item) => (
        <a
          key={item.route}
          href={ROUTE_PATHS[item.route]}
          aria-current={route === item.route ? "page" : undefined}
          onClick={(event) => follow(event, ROUTE_PATHS[item.route])}
        >
          {item.label}
        </a>
      ))}
    </nav>
  );
}
