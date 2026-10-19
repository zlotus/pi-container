import { generateOpaqueToken, hashOpaqueToken } from "@agent-runtime/auth";
import {
  createDatabaseClient,
  createRepository,
  prepareDatabase,
} from "@agent-runtime/database";
import { parseHttpOrigin } from "@agent-runtime/gateway";
import { WorkerIdSchema } from "@agent-runtime/protocol";
import { z } from "zod";

import { selectWorker } from "./scheduler.js";

const InputSchema = z.object({
  DATABASE_URL: z.string().min(1),
  WORKER_ID: WorkerIdSchema,
  WORKER_GATEWAY_BASE_URL: z.string().optional(),
  action: z.enum(["create", "rotate", "configure-gateway", "disable", "enable", "delete"]),
});

const input = InputSchema.parse({
  DATABASE_URL: process.env.DATABASE_URL,
  WORKER_ID: process.env.WORKER_ID,
  WORKER_GATEWAY_BASE_URL: process.env.WORKER_GATEWAY_BASE_URL,
  action: process.argv[2],
});
const database = createDatabaseClient(input.DATABASE_URL);

try {
  // Same rule as the Control Plane: production leaves migrations to the migrate command.
  await prepareDatabase(database, { migrate: process.env.DATABASE_MIGRATE_ON_START !== "false" });
  const repository = createRepository(database, selectWorker);
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
  } else if (input.action === "disable") {
    // specs.md Phase 18.6: the database triggers take the Worker's Workspaces offline and
    // revoke their model keys in the same transaction.
    const result = await repository.disableWorker(input.WORKER_ID);
    if (result.outcome === "NOT_FOUND") throw new Error(`Worker ${input.WORKER_ID} was not found`);
    if (result.outcome === "ALREADY_DISABLED") {
      process.stdout.write(`WORKER_ID=${input.WORKER_ID}\nSTATUS=already disabled\n`);
    } else {
      process.stdout.write(
        [
          `WORKER_ID=${input.WORKER_ID}`,
          "STATUS=disabled",
          `WORKSPACES_OFFLINE=${result.workspaces}`,
          `MODEL_KEYS_REVOKING=${result.modelKeys}`,
          "",
        ].join("\n"),
      );
      process.stderr.write(
        [
          "The Control Plane closes this Worker's connections within seconds. Its containers",
          "keep running on its host; to stop them, on that host run:",
          `  docker stop $(docker ps -q --filter label=managed_by=worker --filter label=worker_id=${input.WORKER_ID})`,
          "",
        ].join("\n"),
      );
    }
  } else if (input.action === "enable") {
    const token = generateOpaqueToken();
    const result = await repository.enableWorker({
      workerId: input.WORKER_ID,
      credentialHash: hashOpaqueToken(token),
    });
    if (result === "NOT_FOUND") throw new Error(`Worker ${input.WORKER_ID} was not found`);
    if (result === "ALREADY_ENABLED") {
      throw new Error(`Worker ${input.WORKER_ID} is enabled; use worker:rotate to change its credential`);
    }
    process.stdout.write(`WORKER_ID=${input.WORKER_ID}\nWORKER_TOKEN=${token}\n`);
  } else if (input.action === "delete") {
    const result = await repository.deleteWorker(input.WORKER_ID);
    if (result.outcome === "NOT_FOUND") throw new Error(`Worker ${input.WORKER_ID} was not found`);
    if (result.outcome === "ENABLED") {
      throw new Error(`Worker ${input.WORKER_ID} is enabled; run worker:disable first`);
    }
    if (result.outcome === "HAS_WORKSPACES") {
      throw new Error(
        `Worker ${input.WORKER_ID} still has ${result.workspaces} Workspace(s) assigned; it cannot be deleted`,
      );
    }
    process.stdout.write(`WORKER_ID=${input.WORKER_ID}\nSTATUS=deleted\n`);
    process.stderr.write(
      `Remove ${input.WORKER_ID} from WORKER_GATEWAY_TOKENS_JSON. Nothing on its host was changed.\n`,
    );
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
