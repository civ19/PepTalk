// npm run db:migrate
//
// Applies db/migrations/*.sql to DATABASE_URL (from the environment or .env),
// in file-name order, each in its own transaction, skipping ones already
// recorded in schema_migrations. TLS is always on and verified.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = fileURLToPath(new URL('..', import.meta.url));
const envFile = join(root, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const raw = process.env.DATABASE_URL?.trim();
if (!raw) {
  console.error('DATABASE_URL is not set. Add it to .env (see .env.example).');
  process.exit(1);
}
// Same rules as pgClientConfig() in src/capture/main/db.ts.
const url = new URL(raw);
const mode = url.searchParams.get('sslmode');
if (mode && ['disable', 'allow', 'prefer'].includes(mode)) {
  console.error(`DATABASE_URL has sslmode=${mode}; TLS is required.`);
  process.exit(1);
}
url.searchParams.delete('sslmode');
if (!url.password && !process.env.PGPASSWORD) {
  console.error('DATABASE_URL has no password. Use postgres://tsdbadmin:<password>@host:port/tsdb?sslmode=require, or set PGPASSWORD in .env.');
  process.exit(1);
}

const dir = join(root, 'db', 'migrations');
const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
const client = new pg.Client({ connectionString: url.toString(), ssl: { rejectUnauthorized: true }, connectionTimeoutMillis: 15_000 });
await client.connect();
try {
  await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  for (const f of files) {
    if (done.has(f)) {
      console.log(`skip   ${f}`);
      continue;
    }
    await client.query('BEGIN');
    try {
      await client.query(readFileSync(join(dir, f), 'utf8'));
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
      await client.query('COMMIT');
      console.log(`apply  ${f}`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`${f}: ${err.message}`);
    }
  }
} finally {
  await client.end();
}
