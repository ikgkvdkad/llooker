const {
  getDatabasePool,
  ensureSingleCameraSelectionsTable,
  SINGLE_CAMERA_SELECTIONS_TABLE_NAME
} = require('./shared/db.js');
const {
  generateStablePersonDescription,
  evaluateDescriptionGrouping
} = require('./shared/single-description.js');

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
      SELECT id, image_data_url, description, person_group_id
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

  let personGroupId = row.person_group_id || null;

  try {
    // Only assign a group if one has not been set yet.
    if (!personGroupId) {
      const groupsResult = await pool.query(
        `
        SELECT person_group_id, description
        FROM ${SINGLE_CAMERA_SELECTIONS_TABLE_NAME}
        WHERE description IS NOT NULL
          AND person_group_id IS NOT NULL
          AND id <> $1
        `,
        [id]
      );

      const groupMap = new Map();
      for (const groupRow of groupsResult.rows || []) {
        const groupId = groupRow.person_group_id;
        const desc = typeof groupRow.description === 'string' ? groupRow.description : '';
        if (!groupId || !desc) continue;
        const existing = groupMap.get(groupId);
        if (!existing || desc.length > existing.description.length) {
          groupMap.set(groupId, { id: groupId, description: desc });
        }
      }

      const groups = Array.from(groupMap.values());

      const { bestGroupId, bestGroupProbability } = await evaluateDescriptionGrouping(description || '', groups);

      if (bestGroupId && bestGroupProbability >= 90) {
        personGroupId = bestGroupId;
      }
    }
  } catch (groupError) {
    console.error('Failed to evaluate grouping for updated single selection:', {
      id,
      message: groupError?.message,
      stack: groupError?.stack
    });
  }

  try {
    await pool.query(
      `
      UPDATE ${SINGLE_CAMERA_SELECTIONS_TABLE_NAME}
      SET description = $1,
          person_group_id = COALESCE(person_group_id, $2)
      WHERE id = $3
      `,
      [description, personGroupId || null, id]
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


