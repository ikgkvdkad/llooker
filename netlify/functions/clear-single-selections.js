const {
  getDatabasePool,
  ensureSingleCameraSelectionsTable,
  SINGLE_CAMERA_SELECTIONS_TABLE_NAME
} = require('./shared/db.js');

const DEFAULT_ANALYSES_TABLE_NAME = 'portrait_analyses';
const ANALYSES_TABLE_ENV_KEY = 'ANALYSES_TABLE';
const PG_TABLE_NOT_FOUND = '42P01';
const PG_INSUFFICIENT_PRIVILEGE = '42501';
const PG_FEATURE_NOT_SUPPORTED = '0A000';

function isTruncateDisallowed(error) {
  return error?.code === PG_INSUFFICIENT_PRIVILEGE || error?.code === PG_FEATURE_NOT_SUPPORTED;
}

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

  const resultSummary = {
    single: {
      table: SINGLE_CAMERA_SELECTIONS_TABLE_NAME,
      rowsCleared: 0,
      truncated: false
    },
    analyses: {
      table: ANALYSES_TABLE_NAME,
      rowsCleared: 0,
      truncated: false,
      exists: true,
      cleared: false
    }
  };

  try {
    await client.query('BEGIN');

    let singleCleared = null;
    try {
      const singleCountResult = await client.query(
        `SELECT COUNT(*)::int AS count FROM ${SINGLE_CAMERA_SELECTIONS_TABLE_NAME};`
      );
      singleCleared = singleCountResult.rows?.[0]?.count ?? 0;
      console.info('clear-single-selections: counted single rows', {
        table: SINGLE_CAMERA_SELECTIONS_TABLE_NAME,
        count: singleCleared
      });
    } catch (countError) {
      if (countError?.code === PG_INSUFFICIENT_PRIVILEGE) {
        console.warn(
          `Insufficient privilege to count ${SINGLE_CAMERA_SELECTIONS_TABLE_NAME} before clearing. Proceeding without pre-count.`,
          { code: countError.code, message: countError.message }
        );
      } else {
        throw countError;
      }
    }

    let singleTruncated = false;
    try {
      await client.query(`TRUNCATE ${SINGLE_CAMERA_SELECTIONS_TABLE_NAME} RESTART IDENTITY;`);
      singleTruncated = true;
      console.info('clear-single-selections: truncated single selection table.');
    } catch (truncateError) {
      if (isTruncateDisallowed(truncateError)) {
        console.warn(
          `Unable to truncate ${SINGLE_CAMERA_SELECTIONS_TABLE_NAME}; falling back to DELETE.`,
          { code: truncateError?.code, message: truncateError?.message }
        );
        const deleteResult = await client.query(
          `DELETE FROM ${SINGLE_CAMERA_SELECTIONS_TABLE_NAME};`
        );
        singleCleared = Number.isFinite(singleCleared) ? singleCleared : deleteResult?.rowCount ?? 0;
      } else {
        throw truncateError;
      }
    }

    if (!singleTruncated && !Number.isFinite(singleCleared)) {
      singleCleared = 0;
    }

    await client.query('COMMIT');
    resultSummary.single.rowsCleared = Number(singleCleared) || 0;
    resultSummary.single.truncated = singleTruncated;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error('Rollback failed after single table clear:', {
        message: rollbackError?.message,
        stack: rollbackError?.stack
      });
    }
    console.error('Failed to clear single camera selections:', {
      message: error?.message,
      stack: error?.stack,
      code: error?.code
    });
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Failed to clear single selections.',
        code: error?.code || null
      })
    };
  }

  // Attempt to clear analyses table without failing the overall request.
  try {
    const analysesClient = await pool.connect();
    try {
      await analysesClient.query('BEGIN');
      let analysesCleared = null;
      let analysesCountKnown = false;

      try {
        const analysesCountResult = await analysesClient.query(
          `SELECT COUNT(*)::int AS count FROM ${ANALYSES_TABLE_NAME};`
        );
        analysesCleared = analysesCountResult.rows?.[0]?.count ?? 0;
        analysesCountKnown = true;
        console.info('clear-single-selections: counted analyses rows', {
          table: ANALYSES_TABLE_NAME,
          count: analysesCleared
        });
      } catch (countError) {
        if (countError?.code === PG_TABLE_NOT_FOUND) {
          console.warn(
            `Analyses table "${ANALYSES_TABLE_NAME}" does not exist. Skipping analyses truncation.`
          );
          resultSummary.analyses.exists = false;
          await analysesClient.query('ROLLBACK');
          analysesClient.release();
          return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              status: 'ok',
              message: 'Single selections cleared, analyses table missing.',
              tables: resultSummary
            })
          };
        } else if (countError?.code === PG_INSUFFICIENT_PRIVILEGE) {
          console.warn(
            `Insufficient privilege to inspect "${ANALYSES_TABLE_NAME}" before clearing. Attempting to clear without row count.`,
            { code: countError.code, message: countError.message }
          );
        } else {
          throw countError;
        }
      }

      let analysesTruncated = false;
      try {
        await analysesClient.query(`TRUNCATE ${ANALYSES_TABLE_NAME} RESTART IDENTITY;`);
        analysesTruncated = true;
        console.info('clear-single-selections: truncated analyses table.');
      } catch (truncateError) {
        if (isTruncateDisallowed(truncateError)) {
          console.warn(
            `Unable to truncate ${ANALYSES_TABLE_NAME}; falling back to DELETE.`,
            { code: truncateError?.code, message: truncateError?.message }
          );
          const deleteResult = await analysesClient.query(`DELETE FROM ${ANALYSES_TABLE_NAME};`);
          if (!analysesCountKnown) {
            analysesCleared = deleteResult?.rowCount ?? 0;
          }
        } else {
          throw truncateError;
        }
      }

      await analysesClient.query('COMMIT');
      resultSummary.analyses.rowsCleared = Number(analysesCleared) || 0;
      resultSummary.analyses.truncated = analysesTruncated;
      resultSummary.analyses.cleared = true;
    } catch (analysesError) {
      try {
        await analysesClient.query('ROLLBACK');
      } catch {
        // ignore rollback failure for analyses
      }
      console.error('Failed to clear analyses table (non-fatal):', {
        message: analysesError?.message,
        code: analysesError?.code,
        stack: analysesError?.stack
      });
    } finally {
      analysesClient.release();
    }
  } catch (outerError) {
    console.error('Failed to run analyses cleanup (non-fatal):', {
      message: outerError?.message,
      code: outerError?.code,
      stack: outerError?.stack
    });
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      status: 'ok',
      message: 'Single selections and canonical descriptions cleared.',
      tables: resultSummary
    })
  };
};


