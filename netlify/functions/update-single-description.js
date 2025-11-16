const {
  getDatabasePool,
  ensureSingleCameraSelectionsTable,
  SINGLE_CAMERA_SELECTIONS_TABLE_NAME
} = require('./shared/db.js');
const {
  generateStablePersonDescription,
  evaluateDescriptionGrouping,
  GROUPING_MATCH_THRESHOLD
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
        SELECT id, image_data_url, description, person_group_id, grouping_probability, grouping_explanation
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
    let groupingDebugForResponse = null;
    let groupingProbabilityForUpdate = null;
    let groupingExplanationForUpdate = null;

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

        const groupingResult = await evaluateDescriptionGrouping(description || '', groups);
        const bestGroupId = Number.isFinite(Number(groupingResult.bestGroupId))
          ? Number(groupingResult.bestGroupId)
          : null;
        const bestGroupProbability = Number.isFinite(Number(groupingResult.bestGroupProbability))
          ? Math.max(0, Math.min(100, Math.round(Number(groupingResult.bestGroupProbability))))
          : null;
        const explanation = groupingResult.explanation && typeof groupingResult.explanation === 'string'
          ? groupingResult.explanation.trim()
          : '';

        if (
          bestGroupId &&
          bestGroupProbability !== null &&
          bestGroupProbability >= GROUPING_MATCH_THRESHOLD
        ) {
          personGroupId = bestGroupId;
        }

        groupingProbabilityForUpdate = bestGroupProbability;
        groupingExplanationForUpdate = explanation || null;

        groupingDebugForResponse = {
          newDescription: description || '',
          groups,
          bestGroupId,
          bestGroupProbability,
          explanation
        };
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
            person_group_id = COALESCE(person_group_id, $2),
            grouping_probability = COALESCE($3, grouping_probability),
            grouping_explanation = COALESCE($4, grouping_explanation)
        WHERE id = $5
        `,
        [description, personGroupId || null, groupingProbabilityForUpdate, groupingExplanationForUpdate, id]
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
      description,
        groupingProbability: groupingProbabilityForUpdate ?? row.grouping_probability ?? null,
        groupingExplanation: groupingExplanationForUpdate ?? row.grouping_explanation ?? null,
      groupingDebug: groupingDebugForResponse
    })
  };
};


