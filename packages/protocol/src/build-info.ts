import { z } from "zod";

// Replaced with string literals by the release build (scripts/release/build.mjs, esbuild
// `define`); running from source leaves them undefined, which reads as "dev".
declare const __AGENT_RUNTIME_VERSION__: string | undefined;
declare const __AGENT_RUNTIME_COMMIT__: string | undefined;

/** A platform software version as reported and displayed, e.g. `1.0.0-rc.1` or `dev`. */
export const SoftwareVersionSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[0-9A-Za-z][0-9A-Za-z.+-]*$/);

/** The version of this Control Plane or Worker build (specs.md Phase 19.8). */
export const PLATFORM_VERSION: string =
  typeof __AGENT_RUNTIME_VERSION__ === "string" ? __AGENT_RUNTIME_VERSION__ : "dev";

/** The git commit of this build; null when running from source. */
export const PLATFORM_COMMIT: string | null =
  typeof __AGENT_RUNTIME_COMMIT__ === "string" ? __AGENT_RUNTIME_COMMIT__ : null;
