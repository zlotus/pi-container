import { describe, expect, it, vi } from "vitest";

import {
  adminUserUpdateConfirmation,
  adminUsersErrorMessage,
  ApiError,
  runConfirmedAdminUserUpdate,
} from "./App.js";

const user = {
  email: "user@example.test",
  username: "user-phase9",
  role: "user" as const,
};

describe("Admin Users interactions", () => {
  it("describes status and role changes with the preferred user identifier", () => {
    expect(adminUserUpdateConfirmation(user, { status: "disabled" })).toBe(
      'Disable user "user-phase9"?',
    );
    expect(adminUserUpdateConfirmation(user, { status: "active" })).toBe(
      'Enable user "user-phase9"?',
    );
    expect(adminUserUpdateConfirmation(user, { role: "admin" })).toBe(
      'Change "user-phase9" role from user to admin?',
    );
    expect(
      adminUserUpdateConfirmation(
        { ...user, username: null, role: "admin" },
        { role: "user" },
      ),
    ).toBe('Change "user@example.test" role from admin to user?');
  });

  it("sends no managed-user request when confirmation is cancelled", async () => {
    const confirm = vi.fn(() => false);
    const request = vi.fn(async () => undefined);

    await expect(
      runConfirmedAdminUserUpdate(user, { status: "disabled" }, confirm, request),
    ).resolves.toBe(false);
    expect(confirm).toHaveBeenCalledOnce();
    expect(request).not.toHaveBeenCalled();
  });

  it("keeps Admin Users API codes visible in the local error message", () => {
    expect(
      adminUsersErrorMessage(
        new ApiError("At least one active Local Admin is required", 409, "LAST_ACTIVE_LOCAL_ADMIN"),
        "fallback",
      ),
    ).toBe(
      "LAST_ACTIVE_LOCAL_ADMIN: At least one active Local Admin is required",
    );
    expect(
      adminUsersErrorMessage(
        new ApiError("Email or username already exists", 409, "USER_ALREADY_EXISTS"),
        "fallback",
      ),
    ).toBe("USER_ALREADY_EXISTS: Email or username already exists");
    expect(
      adminUsersErrorMessage(new ApiError("Server rejected request", 500), "fallback"),
    ).toBe("Server rejected request");
  });
});
