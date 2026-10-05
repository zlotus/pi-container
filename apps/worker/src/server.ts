import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { createLogger, LoggingConfigSchema } from "@agent-runtime/logging";

import { loadWorkerConfig } from "./config.js";
import { DockerRuntimeCapabilityProbe } from "./capabilities.js";
import { WorkerDaemon } from "./daemon.js";
import { EgressController, localProtectedResolver } from "./egress/controller.js";
import { logEgressEnvironment } from "./egress/environment.js";
import { ExecNftClient } from "./egress/nft.js";
import { buildWorkerGateway } from "./gateway.js";
import { DockerWorkspaceRuntime } from "./runtime.js";

const config = loadWorkerConfig(process.env);
const log = await createLogger("worker", LoggingConfigSchema.parse(process.env));
const egress = new EgressController({
  nft: new ExecNftClient(config.WORKER_EGRESS_NFT_PATH),
  stateDirectory: join(resolve(config.WORKER_MANAGED_ROOT), "egress"),
  resolveLocalProtected: localProtectedResolver(
    config.CONTROL_PLANE_URL,
    config.WORKER_EGRESS_PROTECTED,
  ),
  log,
});
const runtime = new DockerWorkspaceRuntime(config, undefined, undefined, egress);
const capabilityProbe = new DockerRuntimeCapabilityProbe(config);
const daemon = new WorkerDaemon(config, runtime, capabilityProbe, egress, log);
const tls =
  config.WORKER_GATEWAY_TLS_CERT_PATH === undefined ||
  config.WORKER_GATEWAY_TLS_KEY_PATH === undefined
    ? undefined
    : {
        cert: await readFile(config.WORKER_GATEWAY_TLS_CERT_PATH),
        key: await readFile(config.WORKER_GATEWAY_TLS_KEY_PATH),
      };
const gateway = buildWorkerGateway({
  gatewayToken: config.WORKER_GATEWAY_TOKEN,
  workspaceBaseUrl: config.WORKSPACE_BASE_URL,
  resolveWorkspaceTarget: (workspaceId) => runtime.gatewayTarget(workspaceId),
  log,
  ...(tls === undefined ? {} : { tls }),
});

const shutdown = (): void => {
  daemon.stop();
  gateway.close();
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

await new Promise<void>((resolve, reject) => {
  const onError = (error: Error): void => reject(error);
  gateway.once("error", onError);
  gateway.listen(config.WORKER_GATEWAY_PORT, config.WORKER_GATEWAY_HOST, () => {
    gateway.off("error", onError);
    log.info(
      {
        workerId: config.WORKER_ID,
        host: config.WORKER_GATEWAY_HOST,
        port: config.WORKER_GATEWAY_PORT,
        tls: tls !== undefined,
      },
      "worker gateway listening",
    );
    resolve();
  });
});
await logEgressEnvironment(log);
await egress.initialize();
// Running Workspaces must not outlive unverifiable egress rules (fail closed).
await daemon.checkEgress();
daemon.start();
