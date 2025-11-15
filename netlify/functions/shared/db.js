const { Pool } = require('pg');

const DEFAULT_SELECTIONS_TABLE = 'camera_selections';
const SELECTIONS_TABLE_ENV_KEY = 'CAMERA_SELECTIONS_TABLE';
const DEFAULT_SINGLE_SELECTIONS_TABLE = 'single_camera_selections';
const SINGLE_SELECTIONS_TABLE_ENV_KEY = 'SINGLE_CAMERA_SELECTIONS_TABLE';

function resolveSelectionsTableName() {
  const configured = process.env[SELECTIONS_TABLE_ENV_KEY];
  if (!configured) {
    return DEFAULT_SELECTIONS_TABLE;
  }
  const sanitized = configured.trim();
  const isValid = /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(sanitized);
  return isValid ? sanitized : DEFAULT_SELECTIONS_TABLE;
}

function resolveSingleSelectionsTableName() {
  const configured = process.env[SINGLE_SELECTIONS_TABLE_ENV_KEY];
  if (!configured) {
    return DEFAULT_SINGLE_SELECTIONS_TABLE;
  }
  const sanitized = configured.trim();
  const isValid = /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(sanitized);
  return isValid ? sanitized : DEFAULT_SINGLE_SELECTIONS_TABLE;
}

const CAMERA_SELECTIONS_TABLE_NAME = resolveSelectionsTableName();
const SINGLE_CAMERA_SELECTIONS_TABLE_NAME = resolveSingleSelectionsTableName();
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

let ensureSingleSelectionsPromise = null;

function ensureSingleCameraSelectionsTable(pool) {
  if (!pool) {
    return Promise.reject(new Error('Database pool not initialized.'));
  }
  if (ensureSingleSelectionsPromise) {
    return ensureSingleSelectionsPromise;
  }

  const createTableSql = `
    CREATE TABLE IF NOT EXISTS ${SINGLE_CAMERA_SELECTIONS_TABLE_NAME} (
      id BIGSERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      captured_at TIMESTAMPTZ,
      role TEXT,
      image_data_url TEXT NOT NULL,
      viewport JSONB,
      signature TEXT,
      location JSONB,
      description TEXT,
      person_group_id BIGINT
    );
  `;

  const alterTableSql = `
    ALTER TABLE ${SINGLE_CAMERA_SELECTIONS_TABLE_NAME}
    ADD COLUMN IF NOT EXISTS description TEXT;

    ALTER TABLE ${SINGLE_CAMERA_SELECTIONS_TABLE_NAME}
    ADD COLUMN IF NOT EXISTS person_group_id BIGINT;
  `;

  ensureSingleSelectionsPromise = pool.query(createTableSql)
    .then(() => pool.query(alterTableSql))
    .catch((error) => {
      ensureSingleSelectionsPromise = null;
      throw error;
    });

  return ensureSingleSelectionsPromise;
}

module.exports = {
  getDatabasePool,
  ensureCameraSelectionsTable,
  ensureSingleCameraSelectionsTable,
  CAMERA_SELECTIONS_TABLE_NAME,
  SINGLE_CAMERA_SELECTIONS_TABLE_NAME,
  resolveSelectionsTableName,
  resolveSingleSelectionsTableName
};
