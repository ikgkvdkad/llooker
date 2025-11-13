const { Pool } = require('pg');

const DEFAULT_TABLE_NAME = 'portrait_analyses';
const TABLE_ENV_KEY = 'ANALYSES_TABLE';

function resolveTableName() {
  const configured = process.env[TABLE_ENV_KEY];
  if (!configured) {
    return DEFAULT_TABLE_NAME;
  }

  const sanitized = configured.trim();
  const isSafe = /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(sanitized);
  if (!isSafe) {
    console.warn(`Invalid ${TABLE_ENV_KEY} provided. Using default.`, {
      provided: configured
    });
    return DEFAULT_TABLE_NAME;
  }

  return sanitized;
}

const TABLE_NAME = resolveTableName();
const PERSON_GROUPS_TABLE = 'person_groups';
let poolInstance = null;
let ensureTablesPromise = null;

function getDatabasePool() {
  if (poolInstance) {
    return poolInstance;
  }

  const rawConnectionString = (process.env.DATABASE_URL || process.env.NETLIFY_DATABASE_URL)?.trim();

  if (!rawConnectionString) {
    console.error('DATABASE_URL or NETLIFY_DATABASE_URL environment variable is not set.');
    return null;
  }

  const sslRequired = rawConnectionString.includes('sslmode=require');

  poolInstance = new Pool({
    connectionString: rawConnectionString,
    ssl: sslRequired
      ? { rejectUnauthorized: false }
      : undefined
  });

  poolInstance.on('error', (dbError) => {
    console.error('Unexpected database error on idle client.', {
      message: dbError?.message,
      stack: dbError?.stack
    });
  });

  return poolInstance;
}

async function ensureTables(pool) {
  if (!pool) {
    throw new Error('Database pool not initialized.');
  }

  if (ensureTablesPromise) {
    return ensureTablesPromise;
  }

  const createAnalysesSql = `
    CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
      id BIGSERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      captured_at TIMESTAMPTZ,
      role TEXT,
      status TEXT NOT NULL,
      analysis JSONB NOT NULL,
      discriminators JSONB,
      reason TEXT,
      image_data_url TEXT,
      image_bytes_estimated INTEGER,
      viewport_signature TEXT,
      viewport JSONB,
      location JSONB,
      openai_request_id TEXT,
      model TEXT,
      request_meta JSONB
    );
  `;

  const createGroupsSql = `
    CREATE TABLE IF NOT EXISTS ${PERSON_GROUPS_TABLE} (
      id BIGSERIAL PRIMARY KEY,
      identifier TEXT NOT NULL UNIQUE,
      representative_analysis_id BIGINT REFERENCES ${TABLE_NAME}(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `;

  const triggerStatements = [
    `
      CREATE OR REPLACE FUNCTION ${PERSON_GROUPS_TABLE}_set_updated_at()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = NOW();
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `,
    `DROP TRIGGER IF EXISTS ${PERSON_GROUPS_TABLE}_set_updated_at ON ${PERSON_GROUPS_TABLE}`,
    `
      CREATE TRIGGER ${PERSON_GROUPS_TABLE}_set_updated_at
      BEFORE UPDATE ON ${PERSON_GROUPS_TABLE}
      FOR EACH ROW
      EXECUTE FUNCTION ${PERSON_GROUPS_TABLE}_set_updated_at()
    `
  ];

  const alterStatements = [
    `ALTER TABLE ${TABLE_NAME} ADD COLUMN IF NOT EXISTS person_group_id BIGINT REFERENCES ${PERSON_GROUPS_TABLE}(id) ON DELETE SET NULL`,
    `CREATE INDEX IF NOT EXISTS idx_${TABLE_NAME}_person_group_id ON ${TABLE_NAME}(person_group_id)`
  ];

  ensureTablesPromise = pool.query(createAnalysesSql)
    .then(() => pool.query(createGroupsSql))
    .then(async () => {
      for (const statement of triggerStatements) {
        // eslint-disable-next-line no-await-in-loop
        await pool.query(statement);
      }

      for (const statement of alterStatements) {
        // eslint-disable-next-line no-await-in-loop
        await pool.query(statement);
      }
    })
    .catch((error) => {
      ensureTablesPromise = null;
      throw error;
    });

  return ensureTablesPromise;
}

function parseJsonColumn(value) {
  if (!value) {
    return null;
  }

  if (typeof value === 'object') {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch (error) {
    console.warn('Failed to parse JSON column value.', { error: error?.message });
    return null;
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  const pool = getDatabasePool();
  if (!pool) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Database not configured. Set DATABASE_URL or NETLIFY_DATABASE_URL.'
      })
    };
  }

  try {
    await ensureTables(pool);
  } catch (tableError) {
    console.error('Failed to ensure required tables exist:', {
      message: tableError?.message,
      stack: tableError?.stack
    });
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Failed to prepare database tables',
        details: tableError?.message || 'Unknown error'
      })
    };
  }

  const params = event.queryStringParameters || {};
  const role = params.role;
  const limit = Math.min(Math.max(parseInt(params.limit, 10) || 50, 1), 200);
  const offset = Math.max(parseInt(params.offset, 10) || 0, 0);
  const status = params.status || 'ok';

  let query = `
    SELECT 
      a.id,
      a.created_at,
      a.captured_at,
      a.role,
      a.status,
      a.analysis,
      a.discriminators,
      a.image_data_url,
      a.location,
      a.viewport_signature,
      a.person_group_id,
      pg.identifier AS person_group_identifier,
      pg.representative_analysis_id AS person_group_representative_id
    FROM ${TABLE_NAME} a
    LEFT JOIN ${PERSON_GROUPS_TABLE} pg ON pg.id = a.person_group_id
    WHERE 1=1
  `;

  const values = [];
  let valueIndex = 1;

  if (role && (role === 'you' || role === 'me')) {
    query += ` AND role = $${valueIndex}`;
    values.push(role);
    valueIndex++;
  }

  if (status) {
    query += ` AND status = $${valueIndex}`;
    values.push(status);
    valueIndex++;
  }

  query += ` ORDER BY a.created_at DESC`;
  query += ` LIMIT $${valueIndex} OFFSET $${valueIndex + 1}`;
  values.push(limit, offset);

  try {
    const result = await pool.query(query, values);

    const analyses = result.rows.map(row => ({
      id: row.id,
      createdAt: row.created_at,
      capturedAt: row.captured_at,
      role: row.role,
      status: row.status,
      analysis: parseJsonColumn(row.analysis) || {},
      discriminators: parseJsonColumn(row.discriminators) || {},
      imageDataUrl: row.image_data_url,
      location: parseJsonColumn(row.location),
      signature: row.viewport_signature,
      personGroup: row.person_group_id ? {
        id: row.person_group_id,
        identifier: row.person_group_identifier,
        representativeAnalysisId: row.person_group_representative_id
      } : null
    }));

    const countQuery = `
      SELECT COUNT(*) as total
      FROM ${TABLE_NAME}
      WHERE 1=1
      ${role && (role === 'you' || role === 'me') ? `AND role = '${role}'` : ''}
      ${status ? `AND status = '${status}'` : ''}
    `;

    const countResult = await pool.query(countQuery);
    const total = parseInt(countResult.rows[0]?.total || 0, 10);

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        analyses,
        pagination: {
          total,
          limit,
          offset,
          hasMore: offset + analyses.length < total
        }
      })
    };
  } catch (error) {
    console.error('Failed to retrieve analyses:', {
      message: error?.message,
      stack: error?.stack
    });

    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Failed to retrieve analyses',
        details: error?.message || 'Unknown error'
      })
    };
  }
};

