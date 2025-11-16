const {
  getDatabasePool,
  ensureSingleCameraSelectionsTable,
  SINGLE_CAMERA_SELECTIONS_TABLE_NAME
} = require('./shared/db.js');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
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
    console.error('Failed to ensure single camera selections table before delete:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Failed to prepare single selection storage.' })
    };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Invalid JSON body.' })
    };
  }

  const id = Number.isFinite(Number(payload?.id)) ? Number(payload.id) : null;
  if (!id || id <= 0) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'A valid numeric "id" is required.' })
    };
  }

  try {
    const result = await pool.query(
      `
      DELETE FROM ${SINGLE_CAMERA_SELECTIONS_TABLE_NAME}
      WHERE id = $1
      RETURNING id
      `,
      [id]
    );

    const deleted = result.rows?.[0] || null;
    if (!deleted) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: 'Selection not found.' })
      };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id })
    };
  } catch (error) {
    console.error('Failed to delete single camera selection:', {
      id,
      message: error?.message,
      stack: error?.stack
    });
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Failed to delete single selection.' })
    };
  }
};


