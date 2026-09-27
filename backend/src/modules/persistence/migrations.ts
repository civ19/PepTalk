// Applies backend/db/migrations/*.sql in file-name order, each in its own
// transaction, skipping any already recorded in schema_migrations. The
// Electron app's migrations use the same table in a shared database, so file
// names must not repeat theirs (001_init.sql, 002_flags_clips.sql).

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SqlClient } from "./database";

export const MIGRATIONS_DIR = join(
  __dirname,
  "..",
  "..",
  "..",
  "db",
  "migrations",
);

/**
 * `client` must be a single connection (pg.Client, not a Pool) so each
 * migration's BEGIN and COMMIT run on the same session. Returns the files applied.
 */
export async function runMigrations(
  client: SqlClient,
  dir = MIGRATIONS_DIR,
  log: (line: string) => void = console.log,
): Promise<string[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  await client.query(
    "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
  );
  const { rows } = await client.query("SELECT name FROM schema_migrations");
  const done = new Set(rows.map((row) => row.name as string));
  const applied: string[] = [];
  for (const file of files) {
    if (done.has(file)) {
      log(`skip   ${file}`);
      continue;
    }
    const sql = await readFile(join(dir, file), "utf8");
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [
        file,
      ]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw new Error(
        `${file}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    log(`apply  ${file}`);
    applied.push(file);
  }
  return applied;
}
