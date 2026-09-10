import { beforeEach, afterAll, describe, it, expect } from "vitest";
import { withTx, closePool } from "../src/db/pool.js";
import { hashPassword, verifyPassword, grantRole, hasRole, requireRole } from "../src/services/auth.js";
import { truncateAll } from "./helpers.js";

beforeEach(truncateAll);
afterAll(closePool);

describe("auth/RBAC — base", () => {
  it("hash Argon2id verifica a senha correta e rejeita a errada", async () => {
    const hash = await hashPassword("Senha#Forte123");
    expect(hash.startsWith("$argon2id$")).toBe(true);
    expect(await verifyPassword(hash, "Senha#Forte123")).toBe(true);
    expect(await verifyPassword(hash, "errada")).toBe(false);
  });

  it("papéis: admin tem 'admin', não tem 'player'; requireRole autoriza/nega", async () => {
    await withTx(async (c) => {
      const u = await c.query<{ id: string }>(
        "insert into users(email, password_hash) values ('admin@c5.local', 'x') returning id",
      );
      const userId = u.rows[0].id;
      await grantRole(c, userId, "admin");

      expect(await hasRole(c, userId, "admin")).toBe(true);
      expect(await hasRole(c, userId, "player")).toBe(false);

      await expect(requireRole(c, userId, "admin")).resolves.toBeUndefined();
      await expect(requireRole(c, userId, "player")).rejects.toThrow(/acesso negado/i);
    });
  });
});
