import { generateOpaqueToken, hashOpaqueToken } from "@agent-runtime/auth";
import {
  createDatabaseClient,
  createPhase2Repository,
  migrateDatabase,
} from "@agent-runtime/database";
import { WorkerIdSchema } from "@agent-runtime/protocol";
import { z } from "zod";

const InputSchema = z.object({
  DATABASE_URL: z.string().min(1),
  WORKER_ID: WorkerIdSchema,
  action: z.enum(["create", "rotate"]),
});

const input = InputSchema.parse({
  DATABASE_URL: process.env.DATABASE_URL,
  WORKER_ID: process.env.WORKER_ID,
  action: process.argv[2],
});
const database = createDatabaseClient(input.DATABASE_URL);

try {
  await migrateDatabase(database);
  const repository = createPhase2Repository(database);
  const token = generateOpaqueToken();
  if (input.action === "create") {
    await repository.provisionWorker({
      workerId: input.WORKER_ID,
      credentialHash: hashOpaqueToken(token),
    });
  } else {
    const rotated = await repository.rotateWorkerCredential({
      workerId: input.WORKER_ID,
      credentialHash: hashOpaqueToken(token),
    });
    if (!rotated) throw new Error(`Worker ${input.WORKER_ID} was not found`);
  }

  process.stdout.write(`WORKER_ID=${input.WORKER_ID}\nWORKER_TOKEN=${token}\n`);
} finally {
  await database.end({ timeout: 5 });
}
