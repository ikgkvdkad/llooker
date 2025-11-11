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
    return DEFAULT_TABLE_NAME;
  }

  return sanitized;
}

const TABLE_NAME = resolveTableName();

function getDatabasePool() {
  const rawConnectionString = (process.env.DATABASE_URL || process.env.NETLIFY_DATABASE_URL)?.trim();

  if (!rawConnectionString) {
    return null;
  }

  const sslRequired = rawConnectionString.includes('sslmode=require');

  return new Pool({
    connectionString: rawConnectionString,
    ssl: sslRequired ? { rejectUnauthorized: false } : undefined
  });
}

exports.handler = async (event, context) => {
  const pool = getDatabasePool();
  
  if (!pool) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: false,
        error: 'Database not configured',
        envVars: {
          DATABASE_URL: !!process.env.DATABASE_URL,
          NETLIFY_DATABASE_URL: !!process.env.NETLIFY_DATABASE_URL
        }
      })
    };
  }

  try {
    // Check if table exists
    const tableCheckQuery = `
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = $1
      );
    `;
    const tableExists = await pool.query(tableCheckQuery, [TABLE_NAME]);
    
    if (!tableExists.rows[0].exists) {
      await pool.end();
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          success: true,
          tableExists: false,
          tableName: TABLE_NAME,
          message: 'Table does not exist yet - will be created on first write'
        })
      };
    }

    // Count total records
    const countQuery = `SELECT COUNT(*) as total FROM ${TABLE_NAME}`;
    const countResult = await pool.query(countQuery);
    const total = parseInt(countResult.rows[0].total, 10);

    // Get counts by role
    const roleCountQuery = `
      SELECT role, COUNT(*) as count 
      FROM ${TABLE_NAME} 
      GROUP BY role
    `;
    const roleCountResult = await pool.query(roleCountQuery);

    // Get last 5 records
    const recentQuery = `
      SELECT id, created_at, role, status, 
             LENGTH(description) as desc_length,
             LENGTH(image_data_url) as image_size,
             location IS NOT NULL as has_location
      FROM ${TABLE_NAME}
      ORDER BY created_at DESC
      LIMIT 5
    `;
    const recentResult = await pool.query(recentQuery);

    await pool.end();

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: true,
        tableExists: true,
        tableName: TABLE_NAME,
        totalRecords: total,
        recordsByRole: roleCountResult.rows.reduce((acc, row) => {
          acc[row.role || 'null'] = parseInt(row.count, 10);
          return acc;
        }, {}),
        recentRecords: recentResult.rows.map(row => ({
          id: row.id,
          createdAt: row.created_at,
          role: row.role,
          status: row.status,
          descriptionLength: row.desc_length,
          imageSize: row.image_size,
          hasLocation: row.has_location
        }))
      })
    };

  } catch (error) {
    if (pool) await pool.end();
    
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: false,
        error: error.message,
        code: error.code,
        details: error.toString()
      })
    };
  }
};

