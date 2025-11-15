const { Pool } = require('pg');

const DEFAULT_SELECTIONS_TABLE = 'camera_selections';
const SELECTIONS_TABLE_ENV_KEY = 'CAMERA_SELECTIONS_TABLE';

function resolveSelectionsTableName() {
  const configured = process.env[SELECTIONS_TABLE_ENV_KEY];
  if (!configured) {
    return DEFAULT_SELECTIONS_TABLE;
  }
  const sanitized = configured.trim();
  const isValid = /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(sanitized);
  return isValid ? sanitized : DEFAULT_SELECTIONS_TABLE;
}

const CAMERA_SELECTIONS_TABLE_NAME = resolveSelectionsTableName();
let poolInstance = null;
let ensureSelectionsPromise = null;

function getDatabasePool() {
  if (poolInstance) {
    return poolInstance;
  }

  const rawConnectionString = (process.env.DATABASE_URL || process.env.NETLIFY_DATABASE_URL || '').trim();
  if (!rawConnectionString) {
    console.error('DATABASE_URL or NETLIFY_DATABASE_URL is not configured.');
    return null;
  }

  const sslRequired = rawConnectionString.includes('sslmode=require');
  poolInstance = new Pool({
    connectionString: rawConnectionString,
    ssl: sslRequired ? { rejectUnauthorized: false } : undefined
  });

  poolInstance.on('error', (error) => {
    console.error('Unexpected database error on idle client.', {
      message: error?.message,
      stack: error?.stack
    });
  });

  return poolInstance;
}

function ensureCameraSelectionsTable(pool) {
  if (!pool) {
    return Promise.reject(new Error('Database pool not initialized.'));
  }
  if (ensureSelectionsPromise) {
    return ensureSelectionsPromise;
  }

  const createTableSql = `
    CREATE TABLE IF NOT EXISTS ${CAMERA_SELECTIONS_TABLE_NAME} (
      id BIGSERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      captured_at TIMESTAMPTZ,
      role TEXT,
      image_data_url TEXT NOT NULL,
      viewport JSONB,
      signature TEXT,
      location JSONB
    );
  `;

  ensureSelectionsPromise = pool.query(createTableSql).catch((error) => {
    ensureSelectionsPromise = null;
    throw error;
  });

  return ensureSelectionsPromise;
}

module.exports = {
  getDatabasePool,
  ensureCameraSelectionsTable,
  CAMERA_SELECTIONS_TABLE_NAME,
  resolveSelectionsTableName
};
