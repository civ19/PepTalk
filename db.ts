import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';

dotenv.config();

export const pool = new Pool({
  connectionString: process.env.TIGERDATA_URL,
  ssl: { rejectUnauthorized: false }, // Required for cloud databases
  max: 20,
  idleTimeoutMillis: 30000,
});

/**
 * Initializes the TigerData database schema.
 */
export async function initDatabase(): Promise<void> {
  const client = await pool.connect();
  try {
    const schemaSql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8');
    await client.query(schemaSql);
    console.log('✅ TigerData Schema & Hypertables successfully initialized.');
  } catch (err: any) {
    console.error('❌ Failed to initialize TigerData database:', err.message);
    throw err;
  } finally {
    client.release();
  }
}