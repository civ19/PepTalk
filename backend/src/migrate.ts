// npm run db:migrate
//
// Creates the Tiger Data tables this backend needs (backend/db/migrations) in
// DATABASE_URL, taken from the environment or the repo's .env.

import pg from "pg";
import { loadRootEnv } from "./env";
import {
  CONNECTION_TIMEOUT_MS,
  databaseUrlFromEnv,
} from "./modules/persistence/database";
import { runMigrations } from "./modules/persistence/migrations";

async function main(): Promise<void> {
  loadRootEnv();
  const databaseUrl = databaseUrlFromEnv();
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is not set. Add it to .env (see .env.example).",
    );
  }
  const client = new pg.Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
  });
  await client.connect();
  try {
    await runMigrations(client);
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
