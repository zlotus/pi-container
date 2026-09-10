import { describe, expect, it } from "vitest";

import { createDatabaseClient } from "./index.js";

describe("database configuration", () => {
  it("rejects non-PostgreSQL connection URLs", () => {
    expect(() => createDatabaseClient("https://database.internal/app")).toThrow(
      "DATABASE_URL must use the postgres or postgresql scheme",
    );
  });
});
