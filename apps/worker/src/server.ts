import { loadWorkerConfig } from "./config.js";
import { WorkerDaemon } from "./daemon.js";
import { DockerWorkspaceRuntime } from "./runtime.js";

const config = loadWorkerConfig(process.env);
const daemon = new WorkerDaemon(config, new DockerWorkspaceRuntime(config));

const shutdown = (): void => {
  daemon.stop();
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

daemon.start();
