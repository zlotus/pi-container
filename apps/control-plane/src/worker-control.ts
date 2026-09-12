import { hashOpaqueToken } from "@agent-runtime/auth";
import type { Phase2Repository } from "@agent-runtime/database";
import {
  WorkerTokenSchema,
  WorkerToControlMessageSchema,
} from "@agent-runtime/protocol";
import type { FastifyInstance, FastifyRequest } from "fastify";

import type { WorkerChannel } from "./worker-channel.js";

export type WorkerControlStore = Pick<
  Phase2Repository,
  | "findWorkerByCredentialHash"
  | "recordWorkerHello"
  | "recordWorkerHeartbeat"
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
                hostname: message.payload.hostname,
                architecture: message.payload.architecture,
                runtimeImage: message.payload.runtimeImage,
                runtimeVersion: message.payload.runtimeVersion,
                capabilities: message.payload.capabilities,
                maxWorkspaces: message.payload.maxWorkspaces,
                allocatedWorkspaces: message.payload.allocatedWorkspaces,
                systemResources: message.payload.systemResources,
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
                receivedAt: dependencies.now(),
              });
              if (!recorded) closeForPolicy();
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
        }
      });
    },
  );
}
