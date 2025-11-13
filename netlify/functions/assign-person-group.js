import OpenAI from 'openai';
import { Pool } from 'pg';
import { performVisionMatch } from './shared/vision-match.js';

const DEFAULT_TABLE_NAME = 'portrait_analyses';
const TABLE_ENV_KEY = 'ANALYSES_TABLE';
const PERSON_GROUPS_TABLE = 'person_groups';
const DEFAULT_MATCH_THRESHOLD = 75;
const MAX_THRESHOLD = 100;
const MIN_THRESHOLD = 0;

function resolveTableName() {
  const configured = process.env[TABLE_ENV_KEY];
  if (!configured) {
    return DEFAULT_TABLE_NAME;
  }

  const sanitized = configured.trim();
  const isSafe = /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(sanitized);
  if (!isSafe) {
    console.warn(`Invalid ${TABLE_ENV_KEY} provided. Using default.`, {
      provided: configured
    });
    return DEFAULT_TABLE_NAME;
  }

  return sanitized;
}

const TABLE_NAME = resolveTableName();
let poolInstance = null;
let ensureTablesPromise = null;

function getDatabasePool() {
  if (poolInstance) {
    return poolInstance;
  }

  const rawConnectionString = (process.env.DATABASE_URL || process.env.NETLIFY_DATABASE_URL)?.trim();

  if (!rawConnectionString) {
    console.error('DATABASE_URL or NETLIFY_DATABASE_URL environment variable is not set.');
    return null;
  }

  const sslRequired = rawConnectionString.includes('sslmode=require');

  poolInstance = new Pool({
    connectionString: rawConnectionString,
    ssl: sslRequired
      ? { rejectUnauthorized: false }
      : undefined
  });

  poolInstance.on('error', (dbError) => {
    console.error('Unexpected database error on idle client.', {
      message: dbError?.message,
      stack: dbError?.stack
    });
  });

  return poolInstance;
}

async function ensureTables(pool) {
  if (!pool) {
    throw new Error('Database pool not initialized.');
  }

  if (ensureTablesPromise) {
    return ensureTablesPromise;
  }

  const createAnalysesSql = `
    CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
      id BIGSERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      captured_at TIMESTAMPTZ,
      role TEXT,
      status TEXT NOT NULL,
      analysis JSONB NOT NULL,
      discriminators JSONB,
      reason TEXT,
      image_data_url TEXT,
      image_bytes_estimated INTEGER,
      viewport_signature TEXT,
      viewport JSONB,
      location JSONB,
      openai_request_id TEXT,
      model TEXT,
      request_meta JSONB
    );
  `;

  const createGroupsSql = `
    CREATE TABLE IF NOT EXISTS ${PERSON_GROUPS_TABLE} (
      id BIGSERIAL PRIMARY KEY,
      identifier TEXT NOT NULL UNIQUE,
      representative_analysis_id BIGINT REFERENCES ${TABLE_NAME}(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `;

  const triggerStatements = [
    `
      CREATE OR REPLACE FUNCTION ${PERSON_GROUPS_TABLE}_set_updated_at()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = NOW();
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `,
    `DROP TRIGGER IF EXISTS ${PERSON_GROUPS_TABLE}_set_updated_at ON ${PERSON_GROUPS_TABLE}`,
    `
      CREATE TRIGGER ${PERSON_GROUPS_TABLE}_set_updated_at
      BEFORE UPDATE ON ${PERSON_GROUPS_TABLE}
      FOR EACH ROW
      EXECUTE FUNCTION ${PERSON_GROUPS_TABLE}_set_updated_at()
    `
  ];

  const alterStatements = [
    `ALTER TABLE ${TABLE_NAME} ADD COLUMN IF NOT EXISTS person_group_id BIGINT REFERENCES ${PERSON_GROUPS_TABLE}(id) ON DELETE SET NULL`,
    `CREATE INDEX IF NOT EXISTS idx_${TABLE_NAME}_person_group_id ON ${TABLE_NAME}(person_group_id)`
  ];

  ensureTablesPromise = pool.query(createAnalysesSql)
    .then(() => pool.query(createGroupsSql))
    .then(async () => {
      for (const statement of triggerStatements) {
        // eslint-disable-next-line no-await-in-loop
        await pool.query(statement);
      }

      for (const statement of alterStatements) {
        // eslint-disable-next-line no-await-in-loop
        await pool.query(statement);
      }
    })
    .catch((error) => {
      ensureTablesPromise = null;
      throw error;
    });

  return ensureTablesPromise;
}

function identifierToNumber(identifier) {
  if (typeof identifier !== 'string' || !identifier.length) {
    return null;
  }

  let value = 0;
  const upper = identifier.trim().toUpperCase();
  for (let i = 0; i < upper.length; i += 1) {
    const code = upper.charCodeAt(i);
    if (code < 65 || code > 90) {
      return null;
    }
    const digit = code - 65;
    value = value * 26 + digit;
  }
  return value;
}

function numberToIdentifier(value) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid identifier value: ${value}`);
  }

  const digits = [];
  let remainder = value;
  do {
    digits.unshift(remainder % 26);
    remainder = Math.floor(remainder / 26);
  } while (remainder > 0);

  while (digits.length < 2) {
    digits.unshift(0);
  }

  return digits.map((digit) => String.fromCharCode(65 + digit)).join('');
}

function computeNextIdentifier(existingIdentifiers = []) {
  const numericValues = [];

  for (const identifier of existingIdentifiers) {
    const numeric = identifierToNumber(identifier);
    if (numeric !== null) {
      numericValues.push(numeric);
    }
  }

  if (!numericValues.length) {
    return 'AA';
  }

  const maxValue = Math.max(...numericValues);
  return numberToIdentifier(maxValue + 1);
}

function boundThreshold(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return DEFAULT_MATCH_THRESHOLD;
  }
  return Math.min(MAX_THRESHOLD, Math.max(MIN_THRESHOLD, Math.round(value)));
}

async function fetchGroupsWithRepresentatives(pool) {
  const query = `
    SELECT
      pg.id,
      pg.identifier,
      pg.representative_analysis_id,
      rep.image_data_url AS representative_image_data_url,
      rep.analysis AS representative_analysis,
      rep.discriminators AS representative_discriminators,
      rep.captured_at AS representative_captured_at
    FROM ${PERSON_GROUPS_TABLE} pg
    LEFT JOIN ${TABLE_NAME} rep ON rep.id = pg.representative_analysis_id
    ORDER BY pg.id ASC
  `;

  const result = await pool.query(query);
  return result.rows || [];
}

function parseJsonColumn(value) {
  if (!value) {
    return null;
  }

  if (typeof value === 'object') {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch (error) {
    console.warn('Failed to parse JSON column value.', { error: error?.message });
    return null;
  }
}

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch (error) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Invalid JSON body' })
    };
  }

  const recordId = Number(payload?.recordId);
  const force = Boolean(payload?.force);
  const matchThreshold = boundThreshold(
    typeof payload?.matchThreshold === 'number'
      ? payload.matchThreshold
      : Number(payload?.matchThreshold)
  );

  if (!Number.isInteger(recordId) || recordId <= 0) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'recordId must be a positive integer.' })
    };
  }

  const apiKey = process.env.OPENAI_API_KEY || process.env.OPENAIKEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'OpenAI API key not configured' })
    };
  }

  const pool = getDatabasePool();
  if (!pool) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Database not configured. Set DATABASE_URL or NETLIFY_DATABASE_URL.'
      })
    };
  }

  try {
    await ensureTables(pool);
  } catch (tableError) {
    console.error('Failed to ensure tables exist for group assignment:', {
      message: tableError?.message,
      stack: tableError?.stack
    });
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Failed to prepare database tables',
        details: tableError?.message || 'Unknown error'
      })
    };
  }

  const targetResult = await pool.query(
    `
      SELECT
        id,
        role,
        status,
        analysis,
        discriminators,
        image_data_url,
        captured_at,
        person_group_id
      FROM ${TABLE_NAME}
      WHERE id = $1
    `,
    [recordId]
  );

  const targetRow = targetResult.rows?.[0];
  if (!targetRow) {
    return {
      statusCode: 404,
      body: JSON.stringify({ error: `Analysis record ${recordId} not found.` })
    };
  }

  if (targetRow.status !== 'ok') {
    return {
      statusCode: 409,
      body: JSON.stringify({
        error: 'Analysis record is not in status "ok"; grouping requires a successful analysis.',
        status: targetRow.status
      })
    };
  }

  if (!targetRow.image_data_url) {
    return {
      statusCode: 412,
      body: JSON.stringify({
        error: 'Analysis record is missing image data. Capture or upload a valid photo before grouping.'
      })
    };
  }

  const targetAnalysis = parseJsonColumn(targetRow.analysis);
  const targetDiscriminators = parseJsonColumn(targetRow.discriminators);
  if (!targetAnalysis || !targetAnalysis.subject) {
    return {
      statusCode: 412,
      body: JSON.stringify({
        error: 'Analysis metadata incomplete. Re-run analysis before grouping.'
      })
    };
  }

  if (!force && targetRow.person_group_id) {
    const groupResult = await pool.query(
      `
        SELECT id, identifier, representative_analysis_id
        FROM ${PERSON_GROUPS_TABLE}
        WHERE id = $1
      `,
      [targetRow.person_group_id]
    );

    const group = groupResult.rows?.[0] || null;

    return {
      statusCode: 200,
      body: JSON.stringify({
        recordId,
        matched: true,
        created: false,
        threshold: matchThreshold,
        personGroup: group
          ? {
              id: group.id,
              identifier: group.identifier,
              representativeAnalysisId: group.representative_analysis_id
            }
          : null,
        comparisons: [],
        note: 'Record already assigned to a person group. Use force=true to recompute.'
      })
    };
  }

  const groups = await fetchGroupsWithRepresentatives(pool);

  const comparableGroups = groups.filter((group) => (
    group.representative_analysis_id
    && group.representative_image_data_url
    && group.representative_analysis
  ));

  const openai = new OpenAI({ apiKey });

  const candidatePayload = {
    id: targetRow.id,
    role: targetRow.role,
    analysis: targetAnalysis,
    discriminators: targetDiscriminators || {},
    imageDataUrl: targetRow.image_data_url,
    capturedAt: targetRow.captured_at
  };

  const comparisons = [];

  for (const group of comparableGroups) {
    if (group.representative_analysis_id === recordId) {
      comparisons.push({
        groupId: group.id,
        identifier: group.identifier,
        similarity: 100,
        confidence: 'high',
        fatalMismatch: null,
        reasoning: 'Candidate photo is the representative image for this group.'
      });
      continue;
    }
    if (!force && group.id === targetRow.person_group_id) {
      continue;
    }

    const representativeAnalysis = parseJsonColumn(group.representative_analysis) || {};
    const representativeDiscriminators = parseJsonColumn(group.representative_discriminators) || {};

    const representativePayload = {
      id: group.representative_analysis_id,
      analysis: representativeAnalysis,
      discriminators: representativeDiscriminators,
      imageDataUrl: group.representative_image_data_url,
      capturedAt: group.representative_captured_at
    };

    try {
      const result = await performVisionMatch(openai, candidatePayload, representativePayload);
      comparisons.push({
        groupId: group.id,
        identifier: group.identifier,
        similarity: result.similarity,
        confidence: result.confidence,
        fatalMismatch: result.fatalMismatch,
        reasoning: result.reasoning
      });
    } catch (error) {
      console.error('Vision comparison failed for group:', {
        groupId: group.id,
        identifier: group.identifier,
        error: error?.message
      });
      comparisons.push({
        groupId: group.id,
        identifier: group.identifier,
        error: error?.message || 'Vision comparison failed.'
      });
    }
  }

  const validComparisons = comparisons.filter(
    (comparison) => typeof comparison.similarity === 'number'
  );

  if (comparableGroups.length > 0 && validComparisons.length === 0) {
    return {
      statusCode: 502,
      body: JSON.stringify({
        error: 'Vision comparison failed for all existing groups. Grouping aborted.',
        comparisons
      })
    };
  }

  let bestMatch = null;
  for (const comparison of validComparisons) {
    if (!bestMatch || comparison.similarity > bestMatch.similarity) {
      bestMatch = comparison;
    }
  }

  const client = await pool.connect();
  try {
    if (
      bestMatch
      && bestMatch.similarity >= matchThreshold
      && !bestMatch.fatalMismatch
    ) {
      const matchedGroup = comparableGroups.find((group) => group.id === bestMatch.groupId) || null;
      await client.query('BEGIN');
      await client.query(
        `UPDATE ${TABLE_NAME} SET person_group_id = $1 WHERE id = $2`,
        [bestMatch.groupId, recordId]
      );
      await client.query('COMMIT');

      return {
        statusCode: 200,
        body: JSON.stringify({
          recordId,
          matched: true,
          created: false,
          threshold: matchThreshold,
          personGroup: {
            id: bestMatch.groupId,
            identifier: bestMatch.identifier,
            representativeAnalysisId: matchedGroup?.representative_analysis_id ?? null
          },
          comparisons
        })
      };
    }

    const identifierRows = await pool.query(
      `SELECT identifier FROM ${PERSON_GROUPS_TABLE} ORDER BY identifier ASC`
    );
    const existingIdentifiers = identifierRows.rows?.map((row) => row.identifier) || [];
    const nextIdentifier = computeNextIdentifier(existingIdentifiers);

    await client.query('BEGIN');
    const insertResult = await client.query(
      `
        INSERT INTO ${PERSON_GROUPS_TABLE} (identifier, representative_analysis_id)
        VALUES ($1, $2)
        RETURNING id, identifier, representative_analysis_id
      `,
      [nextIdentifier, recordId]
    );

    const newGroup = insertResult.rows?.[0];

    await client.query(
      `UPDATE ${TABLE_NAME} SET person_group_id = $1 WHERE id = $2`,
      [newGroup.id, recordId]
    );
    await client.query('COMMIT');

    return {
      statusCode: 200,
      body: JSON.stringify({
        recordId,
        matched: false,
        created: true,
        threshold: matchThreshold,
        personGroup: {
          id: newGroup.id,
          identifier: newGroup.identifier,
          representativeAnalysisId: newGroup.representative_analysis_id
        },
        comparisons
      })
    };
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error('Rollback failed after group assignment error:', {
        message: rollbackError?.message
      });
    }
    console.error('Failed to assign person group:', {
      message: error?.message,
      stack: error?.stack
    });
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Failed to assign person group',
        details: error?.message || 'Unknown error',
        comparisons
      })
    };
  } finally {
    client.release();
  }
};
