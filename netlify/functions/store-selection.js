const {
  getDatabasePool,
  ensureCameraSelectionsTable,
  CAMERA_SELECTIONS_TABLE_NAME
} = require('./shared/db.js');

function normalizeRole(role) {
  if (typeof role !== 'string') {
    return null;
  }
  const trimmed = role.trim().toLowerCase();
  if (!trimmed.length) {
    return null;
  }
  if (trimmed === 'you' || trimmed === 'me') {
    return trimmed;
  }
  return trimmed;
}

function sanitizeViewport(viewport) {
  if (!viewport || typeof viewport !== 'object') {
    return null;
  }
  try {
    return JSON.parse(JSON.stringify(viewport));
  } catch {
    return null;
  }
}

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
    await ensureCameraSelectionsTable(pool);
  } catch (error) {
    console.error('Failed to ensure camera selections table:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Failed to prepare storage.' })
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

  const imageDataUrl = typeof payload?.imageDataUrl === 'string' ? payload.imageDataUrl : '';
  if (!imageDataUrl.startsWith('data:image/')) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'imageDataUrl must be a valid data URL.' })
    };
  }

  const role = normalizeRole(payload.role);
  const viewport = sanitizeViewport(payload.viewport);
  const capturedAt = payload.capturedAt ? new Date(payload.capturedAt) : null;
  const signature = typeof payload.signature === 'string' ? payload.signature.slice(0, 512) : null;

  const insertQuery = {
    text: `
      INSERT INTO ${CAMERA_SELECTIONS_TABLE_NAME} (role, image_data_url, viewport, signature, captured_at)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, created_at, captured_at, role
    `,
    values: [
      role,
      imageDataUrl,
      viewport ? JSON.stringify(viewport) : null,
      signature,
      capturedAt instanceof Date && !Number.isNaN(capturedAt.getTime()) ? capturedAt.toISOString() : null
    ]
  };

  try {
    const result = await pool.query(insertQuery);
    const record = result.rows?.[0];
    return {
      statusCode: 201,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        selection: {
          id: record?.id ?? null,
          createdAt: record?.created_at ?? null,
          capturedAt: record?.captured_at ?? null,
          role: record?.role ?? null
        }
      })
    };
  } catch (error) {
    console.error('Failed to store camera selection:', {
      message: error?.message,
      stack: error?.stack
    });
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Failed to store selection.' })
    };
  }
};
