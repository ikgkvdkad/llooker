const {
  getDatabasePool,
  ensureSingleCameraSelectionsTable,
  SINGLE_CAMERA_SELECTIONS_TABLE_NAME
} = require('./shared/db.js');

const DEFAULT_ANALYSES_TABLE_NAME = 'portrait_analyses';
const ANALYSES_TABLE_ENV_KEY = 'ANALYSES_TABLE';
const PG_TABLE_NOT_FOUND = '42P01';
const PG_INSUFFICIENT_PRIVILEGE = '42501';

function resolveAnalysesTableName() {
  const configured = process.env[ANALYSES_TABLE_ENV_KEY];
  if (!configured) {
    return DEFAULT_ANALYSES_TABLE_NAME;
  }
  const trimmed = configured.trim();
  const isValid = /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(trimmed);
  if (!isValid) {
    console.warn(
      `Invalid ${ANALYSES_TABLE_ENV_KEY} value "${configured}". Falling back to default "${DEFAULT_ANALYSES_TABLE_NAME}".`
    );
    return DEFAULT_ANALYSES_TABLE_NAME;
  }
  return trimmed;
}

const ANALYSES_TABLE_NAME = resolveAnalysesTableName();

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
    console.error('Failed to ensure single camera selections table before clear:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Failed to prepare single selection storage.' })
    };
  }

  const client = await pool.connect();
  let singleCleared = 0;
  let analysesCleared = 0;
  let analysesTableTruncated = false;
  let analysesTableExists = false;
  let analysesCountKnown = false;
  let shouldAttemptAnalysesClear = true;
  let singleTableTruncated = true;

  try {
    await client.query('BEGIN');

    try {
      const singleCountResult = await client.query(
        `SELECT COUNT(*)::int AS count FROM ${SINGLE_CAMERA_SELECTIONS_TABLE_NAME};`
      );
      singleCleared = singleCountResult.rows?.[0]?.count ?? 0;
    } catch (countError) {
      if (countError?.code === PG_INSUFFICIENT_PRIVILEGE) {
        console.warn(
          `Insufficient privilege to count ${SINGLE_CAMERA_SELECTIONS_TABLE_NAME} before clearing. Proceeding without pre-count.`
        );
        singleCleared = null;
      } else {
        throw countError;
      }
    }

    try {
      await client.query(`TRUNCATE ${SINGLE_CAMERA_SELECTIONS_TABLE_NAME} RESTART IDENTITY;`);
      singleTableTruncated = true;
    } catch (truncateError) {
      if (truncateError?.code === PG_INSUFFICIENT_PRIVILEGE) {
        console.warn(
          `Insufficient privilege to truncate ${SINGLE_CAMERA_SELECTIONS_TABLE_NAME}. Falling back to DELETE.`
        );
        const deleteResult = await client.query(
          `DELETE FROM ${SINGLE_CAMERA_SELECTIONS_TABLE_NAME};`
        );
        if (!Number.isFinite(singleCleared)) {
          singleCleared = deleteResult?.rowCount ?? 0;
        }
        singleTableTruncated = false;
      } else {
        throw truncateError;
      }
    }

    try {
      const analysesCountResult = await client.query(
        `SELECT COUNT(*)::int AS count FROM ${ANALYSES_TABLE_NAME};`
      );
      analysesCleared = analysesCountResult.rows?.[0]?.count ?? 0;
      analysesTableExists = true;
      analysesCountKnown = true;
    } catch (countError) {
      if (countError?.code === PG_TABLE_NOT_FOUND) {
        console.warn(
          `Analyses table "${ANALYSES_TABLE_NAME}" does not exist. Skipping analyses truncation.`
        );
        analysesTableExists = false;
        shouldAttemptAnalysesClear = false;
      } else if (countError?.code === PG_INSUFFICIENT_PRIVILEGE) {
        console.warn(
          `Insufficient privilege to inspect "${ANALYSES_TABLE_NAME}" before clearing. Attempting to clear without row count.`
        );
        analysesTableExists = true;
        analysesCountKnown = false;
      } else {
        throw countError;
      }
    }

    if (shouldAttemptAnalysesClear && analysesTableExists) {
      try {
        await client.query(`TRUNCATE ${ANALYSES_TABLE_NAME} RESTART IDENTITY;`);
        analysesTableTruncated = true;
      } catch (truncateError) {
        if (truncateError?.code === PG_INSUFFICIENT_PRIVILEGE) {
          console.warn(
            `Insufficient privilege to truncate ${ANALYSES_TABLE_NAME}. Falling back to DELETE.`
          );
          try {
            const deleteResult = await client.query(`DELETE FROM ${ANALYSES_TABLE_NAME};`);
            if (!analysesCountKnown) {
              analysesCleared = deleteResult?.rowCount ?? 0;
            }
            analysesTableTruncated = false;
          } catch (deleteError) {
            if (deleteError?.code === PG_INSUFFICIENT_PRIVILEGE) {
              console.warn(
                `Insufficient privilege to delete ${ANALYSES_TABLE_NAME}. Canonical descriptions were not removed.`
              );
              analysesCleared = analysesCountKnown ? analysesCleared : 0;
              analysesTableTruncated = false;
              analysesTableExists = true;
            } else {
              throw deleteError;
            }
          }
        } else if (truncateError?.code === PG_TABLE_NOT_FOUND) {
          console.warn(
            `Analyses table "${ANALYSES_TABLE_NAME}" disappeared before clearing. Skipping.`
          );
          analysesTableExists = false;
        } else {
          throw truncateError;
        }
      }
    }

    await client.query('COMMIT');
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error('Rollback failed after clear-single-selections error:', {
        message: rollbackError?.message,
        stack: rollbackError?.stack
      });
    }
    console.error('Failed to clear single camera selections:', {
      message: error?.message,
      stack: error?.stack
    });
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Failed to clear single selections.' })
    };
  } finally {
    client.release();
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      status: 'ok',
      message: 'Single selections and canonical descriptions cleared.',
      tables: {
        single: {
          table: SINGLE_CAMERA_SELECTIONS_TABLE_NAME,
          rowsCleared: singleCleared,
          truncated: singleTableTruncated
        },
        analyses: {
          table: ANALYSES_TABLE_NAME,
          rowsCleared: analysesCleared,
          truncated: analysesTableTruncated,
          exists: analysesTableExists
        }
      }
    })
  };
};


