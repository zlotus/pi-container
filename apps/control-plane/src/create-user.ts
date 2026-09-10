import { randomUUID } from "node:crypto";

import { hashPassword } from "@agent-runtime/auth";
import {
  createDatabaseClient,
  createPhase1Repository,
  migrateDatabase,
} from "@agent-runtime/database";
import { z } from "zod";

const InputSchema = z.object({
  DATABASE_URL: z.string().min(1),
  LOCAL_USER_EMAIL: z.string().email().transform((value) => value.toLowerCase()),
  LOCAL_USER_USERNAME: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9][a-z0-9._-]{2,63}$/)
    .optional(),
  LOCAL_USER_PASSWORD: z.string().min(12).max(1_024),
  LOCAL_USER_ROLE: z.enum(["user", "admin"]).default("user"),
});

const input = InputSchema.parse(process.env);
const database = createDatabaseClient(input.DATABASE_URL);

try {
  await migrateDatabase(database);
  const repository = createPhase1Repository(database);
  const user = await repository.createUser({
    id: randomUUID(),
    email: input.LOCAL_USER_EMAIL,
    username: input.LOCAL_USER_USERNAME ?? null,
    passwordHash: await hashPassword(input.LOCAL_USER_PASSWORD),
    role: input.LOCAL_USER_ROLE,
  });
  console.log(`Created ${user.role} user ${user.email}.`);
} finally {
  await database.end({ timeout: 5 });
}
