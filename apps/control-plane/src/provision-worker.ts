import { generateOpaqueToken, hashOpaqueToken } from "@agent-runtime/auth";
import {
  createDatabaseClient,
  createPhase4Repository,
  migrateDatabase,
} from "@agent-runtime/database";
import { parseHttpOrigin } from "@agent-runtime/gateway";
import { WorkerIdSchema } from "@agent-runtime/protocol";
import { z } from "zod";

const InputSchema = z.object({
  DATABASE_URL: z.string().min(1),
  WORKER_ID: WorkerIdSchema,
  WORKER_GATEWAY_BASE_URL: z.string().optional(),
  action: z.enum(["create", "rotate", "configure-gateway"]),
});

const input = InputSchema.parse({
  DATABASE_URL: process.env.DATABASE_URL,
  WORKER_ID: process.env.WORKER_ID,
  WORKER_GATEWAY_BASE_URL: process.env.WORKER_GATEWAY_BASE_URL,
  action: process.argv[2],
});
const database = createDatabaseClient(input.DATABASE_URL);

try {
  await migrateDatabase(database);
  const repository = createPhase4Repository(database);
  if (input.action === "create") {
    if (input.WORKER_GATEWAY_BASE_URL === undefined) {
      throw new Error("WORKER_GATEWAY_BASE_URL is required when provisioning a Worker");
    }
    const gatewayBaseUrl = parseHttpOrigin(input.WORKER_GATEWAY_BASE_URL);
    const token = generateOpaqueToken();
    const gatewayToken = generateOpaqueToken();
    await repository.provisionWorkerWithGateway({
      workerId: input.WORKER_ID,
      credentialHash: hashOpaqueToken(token),
      gatewayBaseUrl: gatewayBaseUrl.origin,
    });
    process.stdout.write(
      `WORKER_ID=${input.WORKER_ID}\nWORKER_TOKEN=${token}\nWORKER_GATEWAY_TOKEN=${gatewayToken}\n`,
    );
  } else if (input.action === "rotate") {
    const token = generateOpaqueToken();
    const rotated = await repository.rotateWorkerCredential({
      workerId: input.WORKER_ID,
      credentialHash: hashOpaqueToken(token),
    });
    if (!rotated) throw new Error(`Worker ${input.WORKER_ID} was not found`);
    process.stdout.write(`WORKER_ID=${input.WORKER_ID}\nWORKER_TOKEN=${token}\n`);
  } else {
    if (input.WORKER_GATEWAY_BASE_URL === undefined) {
      throw new Error("WORKER_GATEWAY_BASE_URL is required");
    }
    const gatewayBaseUrl = parseHttpOrigin(input.WORKER_GATEWAY_BASE_URL);
    const configured = await repository.configureWorkerGateway({
      workerId: input.WORKER_ID,
      gatewayBaseUrl: gatewayBaseUrl.origin,
    });
    if (!configured) throw new Error(`Worker ${input.WORKER_ID} was not found`);
    process.stdout.write(
      `WORKER_ID=${input.WORKER_ID}\nWORKER_GATEWAY_TOKEN=${generateOpaqueToken()}\n`,
    );
  }
} finally {
  await database.end({ timeout: 5 });
}
