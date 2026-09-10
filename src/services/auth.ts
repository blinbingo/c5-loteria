// Base de autenticação/autorização. Hash de senha com Argon2id (aprovado para o
// C5). RBAC mínimo: checagem de papéis. 2FA/admin e sessões completas entram na
// fase D; aqui ficam as primitivas testáveis da fundação.
import argon2 from "argon2";
import type { PoolClient } from "pg";

export type Role = "player" | "admin" | "operator" | "viewer";

export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, { type: argon2.argon2id });
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}

export async function grantRole(client: PoolClient, userId: string, role: Role): Promise<void> {
  await client.query(
    "insert into user_roles(user_id, role) values ($1,$2) on conflict do nothing",
    [userId, role],
  );
}

export async function hasRole(client: PoolClient, userId: string, role: Role): Promise<boolean> {
  const r = await client.query("select 1 from user_roles where user_id=$1 and role=$2", [userId, role]);
  return (r.rowCount ?? 0) > 0;
}

// Autorização: estoura se o usuário não tiver o papel exigido.
export async function requireRole(client: PoolClient, userId: string, role: Role): Promise<void> {
  if (!(await hasRole(client, userId, role))) {
    throw new Error(`acesso negado: exige papel '${role}'`);
  }
}
