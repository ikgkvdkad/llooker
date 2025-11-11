const { Pool } = require('pg');

exports.handler = async (event, context) => {
  const databaseUrl = process.env.DATABASE_URL || process.env.NETLIFY_DATABASE_URL;
  
  // Check if DATABASE_URL exists
  if (!databaseUrl) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        success: false,
        error: 'DATABASE_URL or NETLIFY_DATABASE_URL not set',
        message: 'Add Netlify Postgres addon or set DATABASE_URL manually'
      })
    };
  }

  // Try to connect
  let pool;
  try {
    const sslRequired = databaseUrl.includes('sslmode=require');
    pool = new Pool({
      connectionString: databaseUrl,
      ssl: sslRequired ? { rejectUnauthorized: false } : undefined
    });

    // Test query
    const result = await pool.query('SELECT NOW() as current_time, version() as pg_version');
    
    await pool.end();

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        message: 'Database connection successful!',
        data: {
          currentTime: result.rows[0].current_time,
          postgresVersion: result.rows[0].pg_version.split(' ')[0] + ' ' + result.rows[0].pg_version.split(' ')[1]
        }
      })
    };

  } catch (error) {
    if (pool) await pool.end();
    
    return {
      statusCode: 500,
      body: JSON.stringify({
        success: false,
        error: 'Database connection failed',
        message: error.message,
        details: {
          code: error.code,
          name: error.name
        }
      })
    };
  }
};

