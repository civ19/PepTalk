import { PGlite } from "@electric-sql/pglite";
import type { SqlClient } from "../src/modules/persistence/database";
import { runMigrations } from "../src/modules/persistence/migrations";

/**
 * An in-process Postgres (PGlite) behind the same interface as pg. As with
 * pg, a query without params may hold several statements (a migration file).
 */
export function pgliteClient(db = new PGlite()): SqlClient {
  return {
    query: async (text, params) =>
      params
        ? db.query(text, params)
        : ((await db.exec(text)).at(-1) ?? { rows: [] }),
  };
}

/** A fresh database with backend/db/migrations applied. */
export async function migratedDb(): Promise<SqlClient> {
  const client = pgliteClient();
  await runMigrations(client, undefined, () => undefined);
  return client;
}
