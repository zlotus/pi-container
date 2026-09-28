import type { ReactNode } from "react";

import type { PortalRoute } from "../router.js";
import type { User } from "../types.js";
import { Navigation } from "./Navigation.js";

export function AppShell({
  children,
  route,
  user,
  onNavigate,
  onLogout,
}: {
  children: ReactNode;
  route: PortalRoute;
  user: User;
  onNavigate: (path: string) => void;
  onLogout: () => void;
}) {
  return (
    <div className="portal-shell">
      <header className="app-header">
        <div className="header-main">
          <div className="brand"><span className="mark">π</span><span>Agent Runtime</span></div>
          <Navigation route={route} role={user.role} onNavigate={onNavigate} />
        </div>
        <div className="account">
          <span>{user.username ?? user.email ?? user.id}</span>
          <button className="quiet" onClick={onLogout}>退出</button>
        </div>
      </header>
      <main className="portal-page">{children}</main>
    </div>
  );
}
