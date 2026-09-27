// Tiger Data connection. DATABASE_URL is a plain postgres:// URL; Tiger
// Cloud's includes sslmode=require, which pg turns into verified TLS.

import pg from "pg";

export const CONNECTION_TIMEOUT_MS = 15_000;

/** The slice of pg used here, so tests can substitute an in-process Postgres (PGlite). */
export interface SqlClient {
  query(text: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

/** DATABASE_URL from the environment, or null when Tiger Data isn't configured. */
export function databaseUrlFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const url = env.DATABASE_URL?.trim();
  return url ? url : null;
}

export function createPool(databaseUrl: string): pg.Pool {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
  });
  // An idle connection dropping must not crash the server; the next query reconnects.
  pool.on("error", (err) =>
    console.error(`[tigerdata] idle connection error: ${err.message}`),
  );
  return pool;
}
