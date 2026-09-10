import { checkDatabase, createDatabaseClient } from "@agent-runtime/database";
import { z } from "zod";

import { buildControlPlane } from "./app.js";

const ServerConfigSchema = z
  .object({
    DATABASE_URL: z.string().min(1),
    HOST: z.string().min(1).default("127.0.0.1"),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  })
  .passthrough();

const config = ServerConfigSchema.parse(process.env);
const database = createDatabaseClient(config.DATABASE_URL);
const app = buildControlPlane({
  checkDatabase: async () => checkDatabase(database),
});

const shutdown = async (): Promise<void> => {
  await app.close();
  await database.end({ timeout: 5 });
};

process.once("SIGINT", () => {
  void shutdown();
});
process.once("SIGTERM", () => {
  void shutdown();
});

await app.listen({ host: config.HOST, port: config.PORT });
