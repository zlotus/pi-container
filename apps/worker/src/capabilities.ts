import { randomUUID } from "node:crypto";

import {
  WorkerCapabilitiesSchema,
  type Architecture,
  type WorkerCapabilities,
} from "@agent-runtime/protocol";
import Docker from "dockerode";
import { z } from "zod";

import type { WorkerConfig } from "./config.js";

const WaitResultSchema = z
  .object({ StatusCode: z.number().int() })
  .passthrough();

export interface RuntimeCapabilityProbe {
  probe(architecture: Architecture): Promise<WorkerCapabilities>;
}

export class DockerRuntimeCapabilityProbe implements RuntimeCapabilityProbe {
  readonly #docker: Docker;
  readonly #image: string;
  readonly #memoryBytes: number;
  readonly #pidsLimit: number;
  readonly #timeoutMs: number;
  readonly #user: string;

  constructor(
    config: WorkerConfig,
    docker = new Docker({ socketPath: config.DOCKER_SOCKET_PATH }),
  ) {
    this.#docker = docker;
    this.#image = config.RUNTIME_IMAGE;
    this.#memoryBytes = config.WORKSPACE_MEMORY_BYTES;
    this.#pidsLimit = config.WORKSPACE_PIDS_LIMIT;
    this.#timeoutMs = config.RUNTIME_CAPABILITY_PROBE_TIMEOUT_MS;
    this.#user = `${config.WORKSPACE_UID}:${config.WORKSPACE_GID}`;
  }

  async probe(architecture: Architecture): Promise<WorkerCapabilities> {
    const image = await this.#docker.getImage(this.#image).inspect();
    if (image.Os !== "linux" || image.Architecture !== architecture) {
      throw new Error(
        `Runtime image platform ${image.Os}/${image.Architecture} does not match linux/${architecture}`,
      );
    }

    const container = await this.#docker.createContainer({
      name: `agent-runtime-capability-probe-${randomUUID()}`,
      Image: this.#image,
      Entrypoint: ["/usr/local/bin/runtime-capability-probe"],
      User: this.#user,
      WorkingDir: "/tmp",
      Tty: true,
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
