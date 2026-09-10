import { loadWorkerConfig } from "./config.js";
import { WorkerDaemon } from "./daemon.js";

const daemon = new WorkerDaemon(loadWorkerConfig(process.env));

const shutdown = (): void => {
  daemon.stop();
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

daemon.start();
