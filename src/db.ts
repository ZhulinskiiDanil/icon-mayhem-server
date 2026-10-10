import pg from 'pg';
import { config } from './config.js';

// The tables are made on start when they are missing: deploying is just running the server

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL,
  username TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS looks (
  id SERIAL PRIMARY KEY,
  account_id INTEGER NOT NULL,
  username TEXT NOT NULL,
  name TEXT NOT NULL,
  look JSONB NOT NULL,
  likes INTEGER NOT NULL DEFAULT 0,
  reports INTEGER NOT NULL DEFAULT 0,
  hidden BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS looks_created ON looks (created_at);
CREATE INDEX IF NOT EXISTS looks_likes ON looks (likes);
CREATE INDEX IF NOT EXISTS looks_account ON looks (account_id);

CREATE TABLE IF NOT EXISTS likes (
  look_id INTEGER NOT NULL REFERENCES looks (id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL,
  PRIMARY KEY (look_id, account_id)
);

CREATE TABLE IF NOT EXISTS reports (
  look_id INTEGER NOT NULL REFERENCES looks (id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (look_id, account_id)
);

CREATE TABLE IF NOT EXISTS icons (
  hash TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  quality INTEGER NOT NULL,
  png TEXT NOT NULL,
  frames JSONB NOT NULL,
  bytes INTEGER NOT NULL,
  reports INTEGER NOT NULL DEFAULT 0,
  hidden BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  used_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS icons_account ON icons (account_id);

CREATE TABLE IF NOT EXISTS worn_looks (
  hash TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL,
  look JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  used_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS worn_looks_account ON worn_looks (account_id);

CREATE TABLE IF NOT EXISTS icon_reports (
  hash TEXT NOT NULL REFERENCES icons (hash) ON DELETE CASCADE,
  account_id INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (hash, account_id)
);
`;

let pool: pg.Pool | null = null;

// Tests hand in their own pool (an in-memory database)
export function usePool(custom: pg.Pool): void {
  pool = custom;
}

export function db(): pg.Pool {
  if (!pool) {
    if (!config.databaseUrl) throw new Error('DATABASE_URL is not set');
    pool = new pg.Pool({
      connectionString: config.databaseUrl,
      ssl: config.databaseSsl ? { rejectUnauthorized: false } : undefined,
      max: 10,
    });
  }
  return pool;
}

export async function initDb(): Promise<void> {
  await db().query(SCHEMA);
}
