const {
  getDatabasePool,
  ensureSingleCameraSelectionsTable,
  SINGLE_CAMERA_SELECTIONS_TABLE_NAME
} = require('./shared/db.js');
const {
  generateStablePersonDescription,
  evaluateDescriptionGrouping
} = require('./shared/single-description.js');

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
    await ensureSingleCameraSelectionsTable(pool);
  } catch (error) {
    console.error('Failed to ensure single camera selections table:', error);
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

  const imageDataUrl = typeof payload?.imageDataUrl === 'string' ? payload.imageDataUrl : '';
  if (!imageDataUrl.startsWith('data:image/')) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'imageDataUrl must be a valid data URL.' })
    };
  }

  const viewport = sanitizeViewport(payload.viewport);
  const capturedAt = payload.capturedAt ? new Date(payload.capturedAt) : null;
  const signature = typeof payload.signature === 'string' ? payload.signature.slice(0, 512) : null;
  const mode = typeof payload.mode === 'string' ? payload.mode.trim().toLowerCase().slice(0, 32) : 'single';

  const description = await generateStablePersonDescription(imageDataUrl);

  let personGroupIdForInsert = null;

  try {
    // Build canonical descriptions per existing person group using longest description.
    const groupsResult = await pool.query(
      `
      SELECT person_group_id, description
      FROM ${SINGLE_CAMERA_SELECTIONS_TABLE_NAME}
      WHERE description IS NOT NULL
        AND person_group_id IS NOT NULL
      `
    );

    const groupMap = new Map();
    for (const row of groupsResult.rows || []) {
      const groupId = row.person_group_id;
      const desc = typeof row.description === 'string' ? row.description : '';
      if (!groupId || !desc) continue;
      const existing = groupMap.get(groupId);
      if (!existing || desc.length > existing.description.length) {
        groupMap.set(groupId, { id: groupId, description: desc });
      }
    }

    const groups = Array.from(groupMap.values());

    const { bestGroupId, bestGroupProbability } = await evaluateDescriptionGrouping(description || '', groups);

    if (bestGroupId && bestGroupProbability >= 66) {
      personGroupIdForInsert = bestGroupId;
    }
  } catch (groupingError) {
    console.error('Failed to evaluate grouping for single selection:', {
      message: groupingError?.message,
      stack: groupingError?.stack
    });
    // Fall back to treating this as a new group; personGroupIdForInsert stays null.
  }

  const insertQuery = {
    text: `
      INSERT INTO ${SINGLE_CAMERA_SELECTIONS_TABLE_NAME} (role, image_data_url, viewport, signature, captured_at, description, person_group_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id, created_at, captured_at, role, description, person_group_id
    `,
    values: [
      mode || 'single',
      imageDataUrl,
      viewport ? JSON.stringify(viewport) : null,
      signature,
      capturedAt instanceof Date && !Number.isNaN(capturedAt.getTime()) ? capturedAt.toISOString() : null,
      description,
      personGroupIdForInsert
    ]
  };

  try {
    const result = await pool.query(insertQuery);
    const record = result.rows?.[0];

    let finalGroupId = record?.person_group_id ?? null;

    // If this was a new person (no group match), use the selection id as its group id.
    if (!finalGroupId && record?.id) {
      finalGroupId = record.id;
      try {
        await pool.query(
          `
          UPDATE ${SINGLE_CAMERA_SELECTIONS_TABLE_NAME}
          SET person_group_id = $1
          WHERE id = $2
          `,
          [finalGroupId, record.id]
        );
      } catch (updateError) {
        console.error('Failed to assign person_group_id for new single selection:', {
          id: record.id,
          message: updateError?.message,
          stack: updateError?.stack
        });
      }
    }

    return {
      statusCode: 201,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        selection: {
          id: record?.id ?? null,
          createdAt: record?.created_at ?? null,
          capturedAt: record?.captured_at ?? null,
          role: record?.role ?? null,
          description: record?.description ?? null,
          personGroupId: finalGroupId ?? null
        }
      })
    };
  } catch (error) {
    console.error('Failed to store single camera selection:', {
      message: error?.message,
      stack: error?.stack
    });
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Failed to store single selection.' })
    };
  }
};


