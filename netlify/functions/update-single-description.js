const {
  getDatabasePool,
  ensureSingleCameraSelectionsTable,
  SINGLE_CAMERA_SELECTIONS_TABLE_NAME
} = require('./shared/db.js');
const { generateStablePersonDescription } = require('./shared/single-description.js');

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
    console.error('Failed to ensure single camera selections table before single update:', error);
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

  let row;
  try {
    const result = await pool.query(
      `
      SELECT id, image_data_url, description
      FROM ${SINGLE_CAMERA_SELECTIONS_TABLE_NAME}
      WHERE id = $1
      `,
      [id]
    );
    row = result.rows?.[0] || null;
  } catch (error) {
    console.error('Failed to load single selection for description update:', {
      id,
      message: error?.message,
      stack: error?.stack
    });
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Failed to load selection for description update.' })
    };
  }

  if (!row) {
    return {
      statusCode: 404,
      body: JSON.stringify({ error: 'Selection not found.' })
    };
  }

  if (!row.image_data_url || typeof row.image_data_url !== 'string') {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Selection is missing stored image data.' })
    };
  }

  let description;
  try {
    description = await generateStablePersonDescription(row.image_data_url);
  } catch (error) {
    console.error('Description generation failed for single selection:', {
      id,
      message: error?.message,
      stack: error?.stack
    });
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Failed to generate description for this selection.' })
    };
  }

  if (!description) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Description generation returned empty content for this selection.' })
    };
  }

  try {
    await pool.query(
      `
      UPDATE ${SINGLE_CAMERA_SELECTIONS_TABLE_NAME}
      SET description = $1
      WHERE id = $2
      `,
      [description, id]
    );
  } catch (error) {
    console.error('Failed to store updated description for single selection:', {
      id,
      message: error?.message,
      stack: error?.stack
    });
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Failed to store updated description for this selection.' })
    };
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id,
      description
    })
  };
};


