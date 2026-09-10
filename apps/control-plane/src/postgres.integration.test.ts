import { randomUUID } from "node:crypto";

import { hashPassword } from "@agent-runtime/auth";
import {
  checkDatabase,
  createDatabaseClient,
  createPhase1Repository,
  migrateDatabase,
  type DatabaseClient,
} from "@agent-runtime/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildControlPlane } from "./app.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl === undefined ? describe.skip : describe;

describeWithPostgres("Phase 1 PostgreSQL integration", () => {
  const userAId = randomUUID();
  const userBId = randomUUID();
  const suffix = randomUUID();
  let database!: DatabaseClient;

  beforeAll(async () => {
    if (databaseUrl === undefined) throw new Error("TEST_DATABASE_URL is required");
    database = createDatabaseClient(databaseUrl);
    await migrateDatabase(database);
    await migrateDatabase(database);
  });

  afterAll(async () => {
    await database`delete from workspaces where user_id in (${userAId}, ${userBId})`;
    await database`delete from users where id in (${userAId}, ${userBId})`;
    await database.end({ timeout: 5 });
  });

  it("logs in two persisted users and isolates their workspaces", async () => {
    const repository = createPhase1Repository(database);
    await repository.createUser({
      id: userAId,
      email: `a-${suffix}@example.test`,
      username: null,
      passwordHash: await hashPassword("integration-password-a"),
      role: "user",
    });
    await repository.createUser({
      id: userBId,
      email: `b-${suffix}@example.test`,
      username: null,
      passwordHash: await hashPassword("integration-password-b"),
      role: "user",
    });

    const app = buildControlPlane({
      checkDatabase: async () => checkDatabase(database),
      store: repository,
      sessionSecret: "integration-session-secret-at-least-32-characters",
      portalOrigin: "http://portal.test",
      secureCookies: false,
      sessionTtlMs: 60 * 60 * 1_000,
      defaultRuntimeImage: "agent-runtime:integration-unassigned",
    });

    async function login(email: string, password: string) {
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { origin: "http://portal.test" },
        payload: { login: email, password },
      });
      expect(response.statusCode).toBe(200);
      const setCookie = response.headers["set-cookie"];
      const header = Array.isArray(setCookie) ? setCookie[0] : setCookie;
      const cookie = header?.split(";")[0];
      if (cookie === undefined) throw new Error("login cookie is missing");
      return {
        cookie,
        csrfToken: response.json<{ csrfToken: string }>().csrfToken,
      };
    }

    const userA = await login(
      `a-${suffix}@example.test`,
      "integration-password-a",
    );
    const userB = await login(
      `b-${suffix}@example.test`,
      "integration-password-b",
    );
    const create = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      headers: {
        cookie: userA.cookie,
        origin: "http://portal.test",
        "x-csrf-token": userA.csrfToken,
      },
      payload: { name: "persisted-workspace" },
    });
    expect(create.statusCode).toBe(201);

    const listA = await app.inject({
      method: "GET",
      url: "/api/workspaces",
      headers: { cookie: userA.cookie },
    });
    const listB = await app.inject({
      method: "GET",
      url: "/api/workspaces",
      headers: { cookie: userB.cookie },
    });
    expect(listA.json()).toMatchObject({
      workspaces: [{ name: "persisted-workspace", state: "CREATED" }],
    });
    expect(listB.json()).toEqual({ workspaces: [] });

    await app.close();
  });
});
