import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // xfwd: the Control Plane sees the browser's address when it trusts this proxy
      // (AUTH_TRUSTED_PROXIES), which login throttling needs (specs.md Phase 15.9).
      "/api": {
        target: process.env.VITE_API_PROXY_TARGET ?? "http://127.0.0.1:3000",
        xfwd: true,
      },
      "/auth": {
        target: process.env.VITE_API_PROXY_TARGET ?? "http://127.0.0.1:3000",
        xfwd: true,
      },
    },
  },
});
