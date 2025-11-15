const {
  getDatabasePool,
  ensureSingleCameraSelectionsTable,
  SINGLE_CAMERA_SELECTIONS_TABLE_NAME
} = require('./shared/db.js');

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
      body: JSON.stringify({ error: 'Database not configured.' })
    };
  }

  try {
    await ensureSingleCameraSelectionsTable(pool);
  } catch (error) {
    console.error('Failed to ensure single camera selections table:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Failed to prepare single selection storage.' })
    };
  }

  const limit = Math.min(Math.max(parseInt(event.queryStringParameters?.limit, 10) || 50, 1), 200);
  const offset = Math.max(parseInt(event.queryStringParameters?.offset, 10) || 0, 0);

  try {
    const listQuery = {
      text: `
        SELECT id, created_at, captured_at, role, image_data_url, description
        FROM ${SINGLE_CAMERA_SELECTIONS_TABLE_NAME}
        ORDER BY created_at DESC
        LIMIT $1 OFFSET $2
      `,
      values: [limit, offset]
    };
    const result = await pool.query(listQuery);

    const countResult = await pool.query(`SELECT COUNT(*) AS total FROM ${SINGLE_CAMERA_SELECTIONS_TABLE_NAME}`);
    const total = parseInt(countResult.rows?.[0]?.total ?? 0, 10);

    const selections = result.rows.map(row => ({
      id: row.id,
      createdAt: row.created_at,
      capturedAt: row.captured_at,
      role: row.role,
      imageDataUrl: row.image_data_url,
      description: row.description || null
    }));

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        selections,
        pagination: {
          total,
          limit,
          offset,
          hasMore: offset + selections.length < total
        }
      })
    };
  } catch (error) {
    console.error('Failed to fetch single camera selections:', {
      message: error?.message,
      stack: error?.stack
    });
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Failed to load single selections.' })
    };
  }
};


