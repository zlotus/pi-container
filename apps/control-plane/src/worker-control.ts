import { hashOpaqueToken } from "@agent-runtime/auth";
import type { Repository } from "@agent-runtime/database";
import {
  WorkerTokenSchema,
  WorkerToControlMessageSchema,
  WORKER_PROTOCOL_VERSION,
} from "@agent-runtime/protocol";
import type { Logger } from "@agent-runtime/logging";
import type { FastifyInstance, FastifyRequest } from "fastify";

import type { PlatformMetrics } from "./metrics/platform-metrics.js";
import type { ComputeActivityTracker } from "./idle/compute-activity.js";
import type { UsageRegistry } from "./metrics/usage-registry.js";
import type { WorkerChannel } from "./worker-channel.js";

export type WorkerControlStore = Pick<
  Repository,
  | "findWorkerByCredentialHash"
  | "recordWorkerHello"
  | "recordWorkerHeartbeat"
  | "activeAssignedWorkspaceIds"
>;

interface WorkerConnectionIdentity {
  workerId: string;
  credentialHash: string;
}

function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (header === undefined || !header.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length);
  const parsed = WorkerTokenSchema.safeParse(token);
  return parsed.success ? parsed.data : null;
}

export function registerWorkerControlChannel(
  app: FastifyInstance,
  dependencies: {
    store: WorkerControlStore;
    channel: WorkerChannel;
    now: () => Date;
    onHelloAccepted?: (workerId: string) => void;
    log?: Logger;
    metrics?: PlatformMetrics;
    usage?: UsageRegistry;
    computeActivity?: ComputeActivityTracker;
  },
): void {
  const identities = new WeakMap<FastifyRequest, WorkerConnectionIdentity>();

  app.get(
    "/api/workers/connect",
    {
      websocket: true,
      preValidation: async (request, reply) => {
        const token = bearerToken(request);
        if (token === null) {
          return reply.code(401).send();
        }
        const credentialHash = hashOpaqueToken(token);
        const identity =
          await dependencies.store.findWorkerByCredentialHash(credentialHash);
        if (identity === null || !identity.enabled) {
          return reply.code(401).send();
        }
        identities.set(request, {
          workerId: identity.workerId,
          credentialHash,
        });
      },
    },
    (socket, request) => {
      const identity = identities.get(request);
      if (identity === undefined) {
        socket.close(1008, "Worker authentication required");
        return;
      }

      let helloAccepted = false;
      let rejected = false;
      let messageQueue = Promise.resolve();

      const closeForPolicy = (): void => {
        rejected = true;
        socket.close(1008, "Worker protocol rejected");
      };

      const credentialStillValid = async (): Promise<boolean> => {
        const current = await dependencies.store.findWorkerByCredentialHash(
          identity.credentialHash,
        );
        return (
          current !== null &&
          current.enabled &&
          current.workerId === identity.workerId
        );
      };

      socket.on("message", (data, isBinary) => {
        messageQueue = messageQueue
          .then(async () => {
            if (rejected) return;
            if (isBinary) {
              closeForPolicy();
              return;
            }
            let decoded: unknown;
            try {
              decoded = JSON.parse(data.toString());
            } catch {
              closeForPolicy();
              return;
            }
            // A Worker on another protocol version is told which one this Control Plane
            // speaks (both are upgraded together, specs.md Phase 19.9.1).
            const version =
              typeof decoded === "object" && decoded !== null && "version" in decoded
                ? (decoded as { version: unknown }).version
                : undefined;
            if (typeof version === "number" && version !== WORKER_PROTOCOL_VERSION) {
              dependencies.log?.warn(
                { workerId: identity.workerId, workerProtocolVersion: version, protocolVersion: WORKER_PROTOCOL_VERSION },
                "worker protocol version mismatch",
              );
              rejected = true;
              socket.close(
                1008,
                `Worker protocol version ${Number.isSafeInteger(version) ? version : "?"} unsupported; Control Plane speaks ${WORKER_PROTOCOL_VERSION}`,
              );
              return;
            }
            const parsed = WorkerToControlMessageSchema.safeParse(decoded);
            if (!parsed.success) {
              closeForPolicy();
              return;
            }
            const message = parsed.data;

            if (message.type === "worker.hello") {
              if (
                helloAccepted ||
                message.payload.workerId !== identity.workerId
              ) {
                closeForPolicy();
                return;
              }
              const recorded = await dependencies.store.recordWorkerHello({
                credentialHash: identity.credentialHash,
                workerId: identity.workerId,
                workerVersion: message.payload.workerVersion,
                hostname: message.payload.hostname,
                architecture: message.payload.architecture,
                runtimeImages: message.payload.runtimeImages,
                maxWorkspaces: message.payload.maxWorkspaces,
                allocatedWorkspaces: message.payload.allocatedWorkspaces,
                systemResources: message.payload.systemResources,
                egress: message.payload.egress,
                storage: message.payload.storage,
                modelRelay: message.payload.modelRelay,
                receivedAt: dependencies.now(),
              });
              if (!recorded) {
                closeForPolicy();
                return;
              }
              helloAccepted = true;
              dependencies.channel.register(identity.workerId, socket);
              dependencies.onHelloAccepted?.(identity.workerId);
              return;
            }

            if (!helloAccepted || !(await credentialStillValid())) {
              closeForPolicy();
              return;
            }

            if (message.type === "worker.heartbeat") {
              if (message.payload.workerId !== identity.workerId) {
                closeForPolicy();
                return;
              }
              const recorded = await dependencies.store.recordWorkerHeartbeat({
                credentialHash: identity.credentialHash,
                workerId: identity.workerId,
                allocatedWorkspaces: message.payload.allocatedWorkspaces,
                egress: message.payload.egress,
                storage: message.payload.storage,
                modelRelay: message.payload.modelRelay,
                workspaceDisk: message.payload.workspaceDisk ?? [],
                receivedAt: dependencies.now(),
              });
              if (recorded === null) {
                dependencies.metrics?.recordHeartbeat(identity.workerId, "rejected");
                closeForPolicy();
                return;
              }
              dependencies.metrics?.recordHeartbeat(identity.workerId, "accepted");
              if (recorded.ignoredDiskSamples > 0) {
                dependencies.log?.warn(
                  { workerId: identity.workerId, ignored: recorded.ignoredDiskSamples },
                  "worker reported disk usage for Workspaces it is not assigned",
                );
              }
              if (dependencies.usage !== undefined) {
                // Usage is observation only: only Workspaces assigned to and running on
                // this Worker are kept (specs.md Phase 17.6).
                const reported = message.payload.workspaceUsage ?? [];
                const assigned = await dependencies.store.activeAssignedWorkspaceIds(
                  identity.workerId,
                  reported.map((sample) => sample.workspaceId),
                );
                // CPU history for idle stop, from the same accepted samples (Phase 18.5).
                dependencies.computeActivity?.record(
                  identity.workerId,
                  reported.filter((sample) => assigned.has(sample.workspaceId)),
                );
                const { ignored } = dependencies.usage.record({
                  workerId: identity.workerId,
                  receivedAt: dependencies.now(),
                  host: message.payload.host,
                  relay: message.payload.modelRelay.stats ?? null,
                  workspaces: reported,
                  assigned,
                });
                if (ignored > 0) {
                  dependencies.log?.warn(
                    { workerId: identity.workerId, ignored },
                    "worker reported usage for Workspaces it is not running",
                  );
                }
              }
              return;
            }

            if (
              (message.type === "event.workspace" ||
                message.type === "event.error") &&
              message.payload.workerId !== identity.workerId
            ) {
              closeForPolicy();
              return;
            }

            if (
              message.type === "response.ok" ||
              message.type === "response.error"
            ) {
              dependencies.channel.acceptResponse(identity.workerId, message);
            }
            // Phase 3 will persist workspace/error events. Phase 2 validates and
            // authenticates them but deliberately has no Runtime state to mutate.
          })
          .catch(() => {
            rejected = true;
            socket.close(1011, "Worker message processing failed");
          });
      });

      socket.on("close", () => {
        rejected = true;
        if (helloAccepted) {
          dependencies.channel.unregister(identity.workerId, socket);
          if (!dependencies.channel.isConnected(identity.workerId)) {
            dependencies.usage?.forget(identity.workerId);
            dependencies.computeActivity?.forgetWorker(identity.workerId);
          }
        }
      });
    },
  );
}
