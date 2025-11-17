const {
  getDatabasePool,
  ensureSingleCameraSelectionsTable,
  SINGLE_CAMERA_SELECTIONS_TABLE_NAME
} = require('./shared/db.js');
const {
  // Reuse deterministic scoring so neighbors align with grouping behavior.
  // Not exported directly, but we can use evaluateDescriptionGrouping with
  // a thin wrapper that exposes full scored groups by re-running the scoring
  // logic in a controlled way if needed in future.
  evaluateDescriptionGrouping
} = require('./shared/single-description.js');

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
    console.error('Failed to ensure single camera selections table before neighbors lookup:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Failed to prepare single selection storage.' })
    };
  }

  const idRaw = event.queryStringParameters && event.queryStringParameters.id;
  const id = Number.isFinite(Number(idRaw)) ? Number(idRaw) : null;
  if (!id || id <= 0) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'A valid numeric "id" query parameter is required.' })
    };
  }

  try {
    const baseResult = await pool.query(
      `
        SELECT id, description_json
        FROM ${SINGLE_CAMERA_SELECTIONS_TABLE_NAME}
        WHERE id = $1
      `,
      [id]
    );
    const baseRow = baseResult.rows?.[0] || null;

    if (!baseRow) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: 'Selection not found.' })
      };
    }

    if (!baseRow.description_json) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: 'Structured description not available for this photo; scoring details cannot be computed yet.'
        })
      };
    }

    const baseSchema = baseRow.description_json;

    const groupsResult = await pool.query(
      `
        SELECT id,
               person_group_id,
               description_json,
               image_data_url,
               created_at,
               captured_at
        FROM ${SINGLE_CAMERA_SELECTIONS_TABLE_NAME}
        WHERE description_json IS NOT NULL
          AND person_group_id IS NOT NULL
          AND id <> $1
      `,
      [id]
    );

    const rows = groupsResult.rows || [];
    if (!rows.length) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          baseSelectionId: id,
          neighbors: []
        })
      };
    }

    // Build canonical entry per group (first row encountered) and member counts.
    const canonicals = new Map();
    const memberCounts = new Map();

    for (const row of rows) {
      const groupId = row.person_group_id;
      if (!groupId || !row.description_json) continue;
      const key = String(groupId);
      memberCounts.set(key, (memberCounts.get(key) || 0) + 1);
      if (!canonicals.has(key)) {
        canonicals.set(key, {
          personGroupId: groupId,
          descriptionSchema: row.description_json,
          imageDataUrl: row.image_data_url,
          createdAt: row.created_at,
          capturedAt: row.captured_at
        });
      }
    }

    const groupList = [];
    for (const [key, canonical] of canonicals.entries()) {
      const count = memberCounts.get(key) || 1;
      groupList.push({
        group_id: canonical.personGroupId,
        group_canonical: canonical.descriptionSchema,
        group_member_count: count
      });
    }

    if (!groupList.length) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          baseSelectionId: id,
          neighbors: []
        })
      };
    }

    // Use evaluateDescriptionGrouping's deterministic scoring logic by
    // calling it per-group to obtain scores and explanations.
    const scored = [];
    for (const group of groupList) {
      const res = await evaluateDescriptionGrouping(baseSchema, [group]);
      const score = Number(res.bestGroupProbability) || 0;
      const explanation = typeof res.explanation === 'string' ? res.explanation : '';
      const groupId = group.group_id;
      if (!groupId) continue;
      scored.push({
        groupId,
        score,
        explanation
      });
    }

    scored.sort((a, b) => b.score - a.score);

    const top = scored.filter((g) => g.score > 0).slice(0, 3);

    const neighbors = top.map((entry) => {
      const key = String(entry.groupId);
      const canonical = canonicals.get(key);
      return {
        personGroupId: entry.groupId,
        score: entry.score,
        explanation: entry.explanation,
        imageDataUrl: canonical ? canonical.imageDataUrl : null,
        createdAt: canonical ? canonical.createdAt : null,
        capturedAt: canonical ? canonical.capturedAt : null
      };
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        baseSelectionId: id,
        neighbors
      })
    };
  } catch (error) {
    console.error('Failed to compute single group neighbors:', {
      id,
      message: error?.message,
      stack: error?.stack
    });
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Failed to compute group neighbors for this selection.' })
    };
  }
};



