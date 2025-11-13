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
let poolInstance = null;

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

  const params = event.queryStringParameters || {};
  const role = params.role;
  const limit = Math.min(Math.max(parseInt(params.limit, 10) || 50, 1), 200);
  const offset = Math.max(parseInt(params.offset, 10) || 0, 0);
  const status = params.status || 'ok';

  let query = `
    SELECT 
      id,
      created_at,
      captured_at,
      role,
      status,
      analysis,
      discriminators,
      image_data_url,
      location,
      viewport_signature
    FROM ${TABLE_NAME}
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

  query += ` ORDER BY created_at DESC`;
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
      signature: row.viewport_signature
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

