const { Pool } = require('pg');

const DEFAULT_TABLE_NAME = 'portrait_descriptions';

function resolveTableName() {
  const configured = process.env.DESCRIPTIONS_TABLE;
  if (!configured) {
    return DEFAULT_TABLE_NAME;
  }

  const sanitized = configured.trim();
  const isSafe = /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(sanitized);
  if (!isSafe) {
    console.warn('Invalid DESCRIPTIONS_TABLE provided. Falling back to default.', {
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

exports.handler = async (event, context) => {
  // Only allow GET requests
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

  // Parse query parameters
  const params = event.queryStringParameters || {};
  const role = params.role; // 'you' or 'me'
  const limit = parseInt(params.limit, 10) || 50;
  const offset = parseInt(params.offset, 10) || 0;
  const status = params.status || 'ok'; // Default to successful descriptions only

  // Build query
  let query = `
    SELECT 
      id,
      created_at,
      captured_at,
      role,
      status,
      description,
      image_data_url,
      location,
      viewport_signature,
      tone
    FROM ${TABLE_NAME}
    WHERE 1=1
  `;

  const values = [];
  let valueIndex = 1;

  // Filter by role if specified
  if (role && (role === 'you' || role === 'me')) {
    query += ` AND role = $${valueIndex}`;
    values.push(role);
    valueIndex++;
  }

  // Filter by status if specified
  if (status) {
    query += ` AND status = $${valueIndex}`;
    values.push(status);
    valueIndex++;
  }

  // Order by created_at descending (newest first)
  query += ` ORDER BY created_at DESC`;

  // Add limit and offset
  query += ` LIMIT $${valueIndex} OFFSET $${valueIndex + 1}`;
  values.push(limit, offset);

  try {
    const result = await pool.query(query, values);

    // Format the results
    const descriptions = result.rows.map(row => {
      const record = {
        id: row.id,
        createdAt: row.created_at,
        capturedAt: row.captured_at,
        role: row.role,
        status: row.status,
        description: row.description,
        imageDataUrl: row.image_data_url,
        tone: row.tone,
        signature: row.viewport_signature
      };

      // Parse location JSON if present
      if (row.location) {
        try {
          const locationData = typeof row.location === 'string' 
            ? JSON.parse(row.location) 
            : row.location;
          record.location = locationData;
        } catch (parseError) {
          console.warn('Failed to parse location data:', parseError);
          record.location = null;
        }
      } else {
        record.location = null;
      }

      return record;
    });

    // Get total count for pagination
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
        descriptions,
        pagination: {
          total,
          limit,
          offset,
          hasMore: offset + descriptions.length < total
        }
      })
    };

  } catch (error) {
    console.error('Failed to retrieve descriptions:', {
      message: error?.message,
      stack: error?.stack
    });

    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Failed to retrieve descriptions',
        details: error?.message || 'Unknown error'
      })
    };
  }
};

