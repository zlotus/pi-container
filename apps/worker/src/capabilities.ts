import { randomUUID } from "node:crypto";

import type { Logger } from "@agent-runtime/logging";
import {
  WorkerCapabilitiesSchema,
  type Architecture,
  type RuntimeImageReport,
  type WorkerCapabilities,
} from "@agent-runtime/protocol";
import Docker from "dockerode";
import { z } from "zod";

import type { WorkerConfig } from "./config.js";
import type { DockerRuntimeImageCatalog } from "./runtime-images.js";

const WaitResultSchema = z
  .object({ StatusCode: z.number().int() })
  .passthrough();

/** Reports the Runtime images this Worker offers and what each can do (Phase 18.4). */
export interface RuntimeCapabilityProbe {
  probe(architecture: Architecture): Promise<RuntimeImageReport[]>;
}

/** Marks probe containers so a Worker can remove the ones an interrupted probe left. */
export const PROBE_LABEL = "io.agent-runtime.probe";

export class DockerRuntimeCapabilityProbe implements RuntimeCapabilityProbe {
  readonly #docker: Docker;
  readonly #catalog: DockerRuntimeImageCatalog;
  readonly #workerId: string;
  readonly #memoryBytes: number;
  readonly #pidsLimit: number;
  readonly #timeoutMs: number;
  readonly #user: string;
  readonly #log: Pick<Logger, "error" | "warn">;

  constructor(
    config: WorkerConfig,
    catalog: DockerRuntimeImageCatalog,
    log: Pick<Logger, "error" | "warn">,
    docker = new Docker({ socketPath: config.DOCKER_SOCKET_PATH }),
  ) {
    this.#docker = docker;
    this.#catalog = catalog;
    this.#workerId = config.WORKER_ID;
    this.#memoryBytes = config.WORKSPACE_MEMORY_BYTES;
    this.#pidsLimit = config.WORKSPACE_PIDS_LIMIT;
    this.#timeoutMs = config.RUNTIME_CAPABILITY_PROBE_TIMEOUT_MS;
    this.#user = `${config.WORKSPACE_UID}:${config.WORKSPACE_GID}`;
    this.#log = log;
  }

  /**
   * Probes every offered image in turn. An image whose probe fails is not reported; when
   * no image can be reported the Worker must not say hello.
   */
  async probe(architecture: Architecture): Promise<RuntimeImageReport[]> {
    const reports: RuntimeImageReport[] = [];
    for (const image of await this.#catalog.refresh(architecture)) {
      if (image.imageId === null) continue;
      try {
        reports.push({
          image: image.image,
          imageId: image.imageId,
          runtimeVersion: image.runtimeVersion,
          piWebVersion: image.piWebVersion,
          piVersion: image.piVersion,
          capabilities: await this.#probeImage(image.image),
        });
      } catch (error) {
        this.#log.error({ image: image.image, err: error }, "Runtime capability probe failed; image not reported");
      }
    }
    if (reports.length === 0) {
      throw new Error("No configured Runtime image is available and verified");
    }
    return reports;
  }

  /** Removes stopped probe containers of this Worker that an interrupted probe left. */
  async removeLeftovers(): Promise<number> {
    const leftovers = await this.#docker.listContainers({
      all: true,
      filters: {
        label: [`${PROBE_LABEL}=${this.#workerId}`],
        status: ["created", "exited", "dead"],
      },
    });
    let removed = 0;
    for (const container of leftovers) {
      if (!container.Names.every((name) => name.startsWith("/agent-runtime-capability-probe-"))) continue;
      try {
        await this.#docker.getContainer(container.Id).remove({ force: false });
        removed += 1;
      } catch (error) {
        this.#log.warn({ err: error }, "could not remove a leftover capability probe container");
      }
    }
    return removed;
  }

  async #probeImage(image: string): Promise<WorkerCapabilities> {
    const container = await this.#docker.createContainer({
      name: `agent-runtime-capability-probe-${randomUUID()}`,
      Image: image,
      Entrypoint: ["/usr/local/bin/runtime-capability-probe"],
      User: this.#user,
      WorkingDir: "/tmp",
      Tty: true,
      Labels: { [PROBE_LABEL]: this.#workerId },
      HostConfig: {
        AutoRemove: false,
        CapDrop: ["ALL"],
        Memory: this.#memoryBytes,
        NetworkMode: "none",
        PidsLimit: this.#pidsLimit,
        Privileged: false,
        SecurityOpt: ["no-new-privileges:true"],
      },
    });

    let timer: NodeJS.Timeout | undefined;
    try {
      await container.start();
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Runtime capability probe timed out")),
          this.#timeoutMs,
        );
      });
      const result = WaitResultSchema.parse(
        await Promise.race([container.wait(), timeout]),
      );
      const output = await container.logs({ stdout: true, stderr: true });
      if (result.StatusCode !== 0) {
        throw new Error("Runtime capability probe did not complete successfully");
      }
      return parseRuntimeCapabilities(output);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      try {
        await container.remove({ force: true });
      } catch {
        // A failed cleanup must not replace the capability result or root error.
      }
    }
  }
}

export function parseRuntimeCapabilities(output: unknown): WorkerCapabilities {
  const decoded = WorkerCapabilitiesSchema.safeParse(output);
  if (decoded.success) return decoded.data;
  const text = Buffer.isBuffer(output) ? output.toString("utf8") : String(output);
  const lines = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const payload = lines.at(-1);
  if (payload === undefined) {
    throw new Error("Runtime capability probe returned no result");
  }
  return WorkerCapabilitiesSchema.parse(JSON.parse(payload) as unknown);
}
