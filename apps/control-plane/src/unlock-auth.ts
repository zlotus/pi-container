import { isIP } from "node:net";

import {
  createDatabaseClient,
  createRepository,
  prepareDatabase,
} from "@agent-runtime/database";
import { z } from "zod";

import {
  AddressSet,
  DEFAULT_LOGIN_GUARD_POLICIES,
  LoginGuard,
  normalizeAddress,
} from "./login-guard.js";
import { selectWorker } from "./scheduler.js";

// Break-glass removal of login locks for operators with access to the Control Plane host
// and its database (specs.md Phase 15.9): `auth:unlock login <login> | ip <address> | all`.
const InputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("login"), value: z.string().trim().min(1).max(320) }),
  z.object({
    action: z.literal("ip"),
    value: z
      .string()
      .trim()
      .refine((value) => isIP(value) !== 0, { message: "expected an IPv4 or IPv6 address" }),
  }),
  z.object({ action: z.literal("all") }),
]);

const environment = z
  .object({ DATABASE_URL: z.string().min(1), SESSION_SECRET: z.string().min(32) })
  .parse(process.env);
const input = InputSchema.parse({ action: process.argv[2], value: process.argv[3] });
const database = createDatabaseClient(environment.DATABASE_URL);

try {
  // Same rule as the Control Plane: production leaves migrations to the migrate command.
  await prepareDatabase(database, { migrate: process.env.DATABASE_MIGRATE_ON_START !== "false" });
  const repository = createRepository(database, selectWorker);
  const now = new Date();
  const common = { now, source: "cli" as const, actorUserId: null, requestId: null };
  let cleared = 0;
  if (input.action === "login") {
    const guard = new LoginGuard(
      environment.SESSION_SECRET,
      DEFAULT_LOGIN_GUARD_POLICIES,
      new AddressSet([]),
    );
    const user = await repository.findUserByLogin(input.value);
    if (user !== null) {
      cleared += await repository.clearAuthLocks({
        ...common,
        target: { kind: "user", userId: user.id },
      });
    }
    // Locks taken out before the login matched a User are keyed by the login text.
    cleared += await repository.clearAuthLocks({
      ...common,
      target: { kind: "keys", keys: guard.accountKeys(guard.accountKey(input.value, null)) },
    });
  } else if (input.action === "ip") {
    cleared = await repository.clearAuthLocks({
      ...common,
      target: { kind: "ip", ipAddress: normalizeAddress(input.value) },
    });
  } else {
    cleared = await repository.clearAuthLocks({ ...common, target: { kind: "all" } });
  }
  console.log(`Cleared ${cleared} active login lock(s).`);
} finally {
  await database.end({ timeout: 5 });
}
