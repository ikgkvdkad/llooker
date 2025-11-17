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
    console.error('Failed to ensure single camera selections table before refresh:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Failed to prepare single selection storage.' })
    };
  }

  let limit = 50;
  try {
    const body = event.body ? JSON.parse(event.body) : {};
    if (body && typeof body.limit === 'number' && Number.isFinite(body.limit)) {
      limit = Math.min(Math.max(body.limit, 1), 200);
    }
  } catch {
    // Ignore body parse errors; fall back to default limit.
  }

  try {
    const selectQuery = {
      text: `
        SELECT id, image_data_url
        FROM ${SINGLE_CAMERA_SELECTIONS_TABLE_NAME}
        WHERE image_data_url IS NOT NULL
          AND (description IS NULL OR description_json IS NULL)
        ORDER BY created_at DESC
        LIMIT $1
      `,
      values: [limit]
    };

    const poolClient = await pool.connect();
    const result = await poolClient.query(selectQuery);
    poolClient.release();

    const rows = result.rows || [];
    let updated = 0;
    const failures = [];

    for (const row of rows) {
      try {
        const descriptionResult = await generateStablePersonDescription(row.image_data_url);
        if (!descriptionResult || !descriptionResult.schema || !descriptionResult.naturalSummary) {
          failures.push({ id: row.id, reason: 'empty_description_or_schema' });
          continue;
        }

        await pool.query(
          `
          UPDATE ${SINGLE_CAMERA_SELECTIONS_TABLE_NAME}
          SET description = $1,
              description_json = $2
          WHERE id = $3
          `,
          [descriptionResult.naturalSummary, JSON.stringify(descriptionResult.schema), row.id]
        );
        updated += 1;
      } catch (error) {
        console.error('Failed to refresh description for single selection:', {
          id: row.id,
          message: error?.message,
          stack: error?.stack
        });
        failures.push({ id: row.id, reason: error?.message || 'unknown_error' });
      }
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        processed: rows.length,
        updated,
        failures
      })
    };
  } catch (error) {
    console.error('Error while refreshing single selection descriptions:', {
      message: error?.message,
      stack: error?.stack
    });
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Failed to refresh descriptions.' })
    };
  }
};


