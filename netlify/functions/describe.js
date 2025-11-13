const { Pool } = require('pg');

const DEFAULT_TABLE_NAME = 'portrait_analyses';
const TABLE_ENV_KEY = 'ANALYSES_TABLE';

function resolveTableName() {
  const configured = process.env[TABLE_ENV_KEY];
  if (!configured) {
    return DEFAULT_TABLE_NAME;
  }

  const sanitized = configured.trim();
  const isSafe = /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(sanitized);
  if (!isSafe) {
    console.warn(`Invalid ${TABLE_ENV_KEY} provided. Falling back to default.`, {
      provided: configured
    });
    return DEFAULT_TABLE_NAME;
  }

  return sanitized;
}

const TABLE_NAME = resolveTableName();
const PERSON_GROUPS_TABLE = 'person_groups';
let poolInstance = null;
let ensureGroupsTablePromise = null;
let ensureTablePromise = null;

function estimateImageBytesFromDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') {
    return null;
  }

  const base64Index = dataUrl.indexOf(',');
  if (base64Index === -1) {
    return null;
  }

  const base64Data = dataUrl.slice(base64Index + 1);
  const paddingMatch = base64Data.match(/=+$/);
  const paddingLength = paddingMatch ? paddingMatch[0].length : 0;

  return Math.floor((base64Data.length * 3) / 4) - paddingLength;
}

function convertToDate(value) {
  if (value === null || value === undefined) {
    return null;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    const fromNumber = new Date(value);
    return Number.isNaN(fromNumber.getTime()) ? null : fromNumber;
  }

  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) {
      return new Date(parsed);
    }
  }

  return null;
}

function buildLocationDocument(locationInput) {
  if (!locationInput || typeof locationInput !== 'object') {
    return null;
  }

  const status = typeof locationInput.status === 'string'
    ? locationInput.status.toLowerCase()
    : 'unknown';

  const locationDoc = { status };

  if (locationInput.error && typeof locationInput.error === 'string') {
    locationDoc.error = locationInput.error;
  }

  const timestamp = convertToDate(locationInput.timestamp);
  if (timestamp) {
    locationDoc.timestamp = timestamp.toISOString();
  }

  if (locationInput.coords && typeof locationInput.coords === 'object') {
    const {
      latitude,
      longitude,
      accuracy,
      altitude,
      altitudeAccuracy,
      heading,
      speed
    } = locationInput.coords;

    if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
      locationDoc.coordinates = { latitude, longitude };
    }
    if (Number.isFinite(accuracy)) {
      locationDoc.accuracy = accuracy;
    }
    if (Number.isFinite(altitude)) {
      locationDoc.altitude = altitude;
    }
    if (Number.isFinite(altitudeAccuracy)) {
      locationDoc.altitudeAccuracy = altitudeAccuracy;
    }
    if (Number.isFinite(heading)) {
      locationDoc.heading = heading;
    }
    if (Number.isFinite(speed)) {
      locationDoc.speed = speed;
    }
  }

  return locationDoc;
}

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

function ensureObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {};
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function normaliseStringList(list) {
  return ensureArray(list)
    .filter(item => typeof item === 'string' && item.trim().length)
    .map(item => item.trim().toLowerCase());
}

function sanitizeAnalysisDoc(raw) {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const normaliseTokenList = (value) => normaliseStringList(
    Array.isArray(value)
      ? value
      : (typeof value === 'string' && value.trim().length ? [value] : [])
  );

  const sanitiseString = (value) => {
    if (typeof value !== 'string') {
      return null;
    }
    const trimmed = value.trim();
    return trimmed.length ? trimmed.toLowerCase() : null;
  };

  const analysis = {
    subject: ensureObject(raw.subject),
    appearance: ensureObject(raw.appearance),
    clothing: ensureObject(raw.clothing),
    accessories: ensureObject(raw.accessories),
    carriedItems: normaliseTokenList(raw.carriedItems),
    confidence: ensureObject(raw.confidence),
    environment: ensureObject(raw.environment)
  };

  const subject = analysis.subject;
  subject.distinguishingFeatures = normaliseTokenList(subject.distinguishingFeatures);
  if (subject.hair && typeof subject.hair === 'object') {
    const hair = {};
    ['color', 'length', 'style'].forEach((key) => {
      hair[key] = sanitiseString(subject.hair[key]);
    });
    subject.hair = hair;
  } else {
    subject.hair = { color: null, length: null, style: null };
  }
  ['gender', 'ageRange', 'ageBucket', 'build', 'bodyType', 'heightCategory', 'skinTone', 'facialHair', 'eyewear', 'headwear'].forEach((key) => {
    subject[key] = sanitiseString(subject[key]);
  });
  if (Number.isFinite(subject.genderConfidence)) {
    subject.genderConfidence = Math.max(0, Math.min(1, Number(subject.genderConfidence)));
  } else {
    subject.genderConfidence = null;
  }

  const appearance = analysis.appearance;
  appearance.dominantColors = normaliseTokenList(appearance.dominantColors);
  appearance.styleDescriptors = normaliseTokenList(appearance.styleDescriptors);
  appearance.patterns = normaliseTokenList(appearance.patterns);
  delete appearance.colorPalette;
  delete appearance.textureDescriptors;
  delete appearance.notableFeatures;

  const clothingKeys = ['top', 'bottom', 'outerwear', 'footwear'];
  clothingKeys.forEach((key) => {
    const block = analysis.clothing[key];
    if (!block || typeof block !== 'object') {
      analysis.clothing[key] = {};
      return;
    }
    const sanitised = {};
    sanitised.category = sanitiseString(block.category);
    sanitised.colors = normaliseTokenList(block.colors);
    sanitised.pattern = sanitiseString(block.pattern);
    sanitised.style = sanitiseString(block.style);
    analysis.clothing[key] = sanitised;
  });
  analysis.clothing.dominantColors = normaliseTokenList(analysis.clothing.dominantColors);
  delete analysis.clothing.additionalLayers;
  delete analysis.clothing.brandLogos;
  delete analysis.clothing.textOrGraphics;

  const accessories = analysis.accessories;
  ['jewelry', 'headwear', 'eyewear', 'handheld', 'bags', 'tech', 'other'].forEach((bucket) => {
    accessories[bucket] = normaliseTokenList(accessories[bucket]);
  });

  const environment = analysis.environment;
  ['setting', 'background', 'lighting', 'crowdLevel'].forEach((key) => {
    environment[key] = sanitiseString(environment[key]);
  });

  const confidence = analysis.confidence;
  ['overall', 'gender', 'age', 'clothing', 'accessories'].forEach((key) => {
    const value = confidence[key];
    if (Number.isFinite(value)) {
      confidence[key] = Math.max(0, Math.min(1, Number(value)));
    } else if (typeof value === 'string' && value.trim().length) {
      const numeric = Number(value);
      confidence[key] = Number.isFinite(numeric)
        ? Math.max(0, Math.min(1, numeric))
        : null;
    } else {
      confidence[key] = null;
    }
  });

  return analysis;
}

function sanitizeDiscriminators(raw) {
  const requiredKeys = ['hair', 'face', 'top', 'bottom', 'footwear', 'accessories', 'carried'];
  const discriminators = {};

  if (raw && typeof raw === 'object') {
    requiredKeys.forEach((key) => {
      const value = raw[key];
      if (typeof value === 'string' && value.trim().length) {
        discriminators[key] = value.trim().toLowerCase();
      }
    });
  } else if (typeof raw === 'string') {
    requiredKeys.forEach((key) => {
      const regex = new RegExp(`${key}\\s*:\\s*([^\\s]+)`, 'i');
      const match = raw.match(regex);
      if (match && match[1]) {
        discriminators[key] = match[1].trim().toLowerCase();
      }
    });
  }

  requiredKeys.forEach((key) => {
    if (!discriminators[key]) {
      discriminators[key] = 'unknown';
    }
  });

  return discriminators;
}

async function ensurePersonGroupsTable(pool) {
  if (!pool) {
    throw new Error('Database pool not initialized.');
  }

  if (ensureGroupsTablePromise) {
    return ensureGroupsTablePromise;
  }

  const createGroupsSql = `
    CREATE TABLE IF NOT EXISTS ${PERSON_GROUPS_TABLE} (
      id BIGSERIAL PRIMARY KEY,
      identifier TEXT NOT NULL UNIQUE,
      representative_analysis_id BIGINT REFERENCES ${TABLE_NAME}(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `;

  ensureGroupsTablePromise = pool.query(createGroupsSql).then(async () => {
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

    for (const statement of triggerStatements) {
      // eslint-disable-next-line no-await-in-loop
      await pool.query(statement);
    }
  }).catch((error) => {
    ensureGroupsTablePromise = null;
    throw error;
  });

  return ensureGroupsTablePromise;
}

async function ensureTableExists(pool) {
  if (!pool) {
    throw new Error('Database pool not initialized.');
  }

  if (ensureTablePromise) {
    return ensureTablePromise;
  }

  const createAnalysesTableSql = `
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

  ensureTablePromise = pool.query(createAnalysesTableSql)
    .then(() => ensurePersonGroupsTable(pool))
    .then(async () => {
      const alterStatements = [
        `ALTER TABLE ${TABLE_NAME} ADD COLUMN IF NOT EXISTS person_group_id BIGINT REFERENCES ${PERSON_GROUPS_TABLE}(id) ON DELETE SET NULL`,
        `CREATE INDEX IF NOT EXISTS idx_${TABLE_NAME}_person_group_id ON ${TABLE_NAME}(person_group_id)`
      ];

      for (const sql of alterStatements) {
        // eslint-disable-next-line no-await-in-loop
        await pool.query(sql);
      }
    })
    .catch((error) => {
      ensureTablePromise = null;
      throw error;
    });

  return ensureTablePromise;
}

async function persistAnalysisRecord(recordInput, requestMeta) {
  const pool = getDatabasePool();
  if (!pool) {
    throw new Error('Database is not configured. Set DATABASE_URL or NETLIFY_DATABASE_URL.');
  }

  try {
    await ensureTableExists(pool);
  } catch (tableError) {
    console.error('Failed to ensure analyses table exists.', {
      message: tableError?.message,
      stack: tableError?.stack,
      tableName: TABLE_NAME
    });
    throw tableError;
  }

  const locationDoc = buildLocationDocument(recordInput.location);
  const capturedAtDate = convertToDate(recordInput.capturedAt);
  const viewportData = recordInput.viewport && typeof recordInput.viewport === 'object'
    ? recordInput.viewport
    : null;

  const insertQuery = {
    text: `
      INSERT INTO ${TABLE_NAME} (
        role,
        status,
        analysis,
        discriminators,
        reason,
        image_data_url,
        image_bytes_estimated,
        viewport_signature,
        viewport,
        location,
        captured_at,
        openai_request_id,
        model,
        request_meta,
        person_group_id
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      RETURNING id;
    `,
    values: [
      recordInput.role || null,
      recordInput.status || null,
      JSON.stringify(recordInput.analysis),
      recordInput.discriminators ? JSON.stringify(recordInput.discriminators) : null,
      recordInput.reason || null,
      recordInput.imageDataUrl,
      recordInput.imageBytesEstimated ?? estimateImageBytesFromDataUrl(recordInput.imageDataUrl),
      recordInput.signature || null,
      viewportData ? JSON.stringify(viewportData) : null,
      locationDoc ? JSON.stringify(locationDoc) : null,
      capturedAtDate || null,
      recordInput.openAiRequestId || null,
      recordInput.model || null,
      requestMeta ? JSON.stringify(requestMeta) : null,
      recordInput.personGroupId || null
    ]
  };

  try {
    const result = await pool.query(insertQuery);
    return result.rows?.[0]?.id ?? null;
  } catch (databaseError) {
    console.error('Failed to persist analysis record to database.', {
      message: databaseError?.message,
      stack: databaseError?.stack,
      tableName: TABLE_NAME,
      requestMeta
    });
    throw databaseError;
  }
}

const SYSTEM_PROMPT = [
  'Return ONLY JSON with top-level fields {status, analysis, discriminators}.',
  'status must be "ok", "unclear", or "error". When status is not "ok", omit analysis and discriminators.',
  'If status is "ok", analysis must include:',
  '  subject: gender, genderConfidence (0-1), ageRange, ageBucket, build, bodyType, heightCategory, skinTone, hair{color,length,style}, facialHair, eyewear, headwear, distinguishingFeatures[].',
  '  appearance: dominantColors[], styleDescriptors[], patterns[].',
  '  clothing: dominantColors[] plus objects top/bottom/outerwear/footwear each with category, colors[], pattern, style.',
  '  accessories: buckets jewelry[], headwear[], eyewear[], handheld[], bags[], tech[], other[].',
  '  carriedItems: array listing obvious handheld or worn items.',
  '  environment: setting, background, lighting, crowdLevel.',
  '  confidence: overall, gender, age, clothing, accessories as numbers between 0 and 1.',
  'discriminators must contain hair, face, top, bottom, footwear, accessories, carried using concise hyphenated tokens (allow "+").',
  'Use "unknown" or [] when uncertain. Do NOT include prose outside the JSON.'
].join(' ');

function buildUserPrompt(selectionInstruction) {
  return [
    'Analyze the framed person for re-identification metadata.',
    'Fill every requested field even if approximate, using concise hyphenated tokens.',
    'Report gender cues, age range, build, skin tone, hair details, eyewear/headwear, and distinguishing features.',
    'Describe clothing (top/bottom/outerwear/footwear) with categories and dominant colours, and list overall outfit colours and patterns.',
    'List accessories (jewelry, bags, tech, handheld items) and any carried objects.',
    'Capture environment setting/background/lighting/crowd level plus confidence scores (0-1).',
    selectionInstruction
  ].join(' ');
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  let requestPayload;

  try {
    requestPayload = JSON.parse(event.body);
  } catch (parseError) {
    console.error('Invalid JSON payload:', parseError);
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Invalid JSON body' })
    };
  }

  const {
    role,
    image,
    selection,
    capturedAt,
    location,
    signature,
    viewport,
    reason
  } = requestPayload;

  const normalizeSelectionValue = (value) => {
    const numeric = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(numeric)) {
      return null;
    }
    return Math.min(1, Math.max(0, numeric));
  };

  const normalizedSelection = selection && typeof selection === 'object'
    ? (() => {
        const x = normalizeSelectionValue(selection.x);
        const y = normalizeSelectionValue(selection.y);
        if (x === null || y === null) {
          return null;
        }
        return { x, y };
      })()
    : null;

  const requestMeta = {
    role: typeof role === 'string' ? role : null,
    imageProvided: typeof image === 'string',
    imageLength: typeof image === 'string' ? image.length : null,
    imageBytesEstimated: estimateImageBytesFromDataUrl(image),
    selection: normalizedSelection,
    signature: typeof signature === 'string' ? signature : null,
    capturedAt,
    reason,
    tableName: TABLE_NAME
  };

  requestMeta.promptVersion = 'v2-compact';
  requestMeta.imageDetail = 'low';
  requestMeta.maxTokens = 550;

  try {
    const databasePool = getDatabasePool();
    if (!databasePool) {
      return {
        statusCode: 500,
        body: JSON.stringify({
          error: 'Database not configured. Set DATABASE_URL or NETLIFY_DATABASE_URL.'
        })
      };
    }
    requestMeta.databaseConnected = true;

    if (!image) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'No image provided' })
      };
    }

    const apiKey = process.env.OPENAI_API_KEY || process.env.OPENAIKEY;
    if (!apiKey) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'OpenAI API key not configured' })
      };
    }

    const selectionInstructionBase =
      'Focus exclusively on the individual within the extracted frame. Ignore surroundings outside the crop. Assume the crop is already aligned with the intended subject.';
    const coordinateInstruction = normalizedSelection
      ? ` The normalized selection center (relative to original image width/height) is approximately x=${normalizedSelection.x.toFixed(3)}, y=${normalizedSelection.y.toFixed(3)}.`
      : '';
    const selectionInstruction = `${selectionInstructionBase}${coordinateInstruction}`;

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: SYSTEM_PROMPT
          },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: buildUserPrompt(selectionInstruction)
              },
              {
                type: 'image_url',
                image_url: {
                  url: image,
                  detail: 'low'
                }
              }
            ]
          }
        ],
        max_tokens: 550,
        response_format: { type: 'json_object' },
        temperature: 0.1
      })
    });

    const openAiRequestId = response.headers.get('x-request-id')
      || response.headers.get('openai-request-id')
      || null;
    requestMeta.openAiRequestId = openAiRequestId;

    if (!response.ok) {
      const errorText = await response.text();
      let openAiResponse;

      try {
        openAiResponse = JSON.parse(errorText);
      } catch {
        openAiResponse = null;
      }

      const openAiError = openAiResponse?.error;

      const errorDetails = {
        status: response.status,
        statusText: response.statusText,
        requestId: openAiRequestId,
        openAiMessage: openAiError?.message ?? null,
        openAiType: openAiError?.type ?? null,
        openAiCode: openAiError?.code ?? null,
        openAiParam: openAiError?.param ?? null,
        requestMeta
      };

      console.error('OpenAI API error:', {
        ...errorDetails,
        rawResponseBodySnippet: typeof errorText === 'string' ? errorText.slice(0, 500) : null
      });

      return {
        statusCode: response.status,
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          error: 'OpenAI API request failed',
          details: {
            ...errorDetails,
            rawResponseBodySnippet: typeof errorText === 'string'
              ? errorText.slice(0, 500)
              : null
          }
        })
      };
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;

    if (!content) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'No analysis returned from OpenAI' })
      };
    }

    let parsed;

    try {
      parsed = JSON.parse(content);
    } catch (parseError) {
      console.error('Failed to parse AI response as JSON.', {
        parseError: parseError?.message,
        rawContentSnippet: typeof content === 'string' ? content.slice(0, 500) : null,
        requestMeta
      });
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'AI response format invalid' })
      };
    }

    const status = typeof parsed?.status === 'string' ? parsed.status.trim().toLowerCase() : null;
    const analysisDoc = sanitizeAnalysisDoc(parsed?.analysis);
    const discriminators = sanitizeDiscriminators(parsed?.discriminators);

    if (status !== 'ok' && status !== 'unclear' && status !== 'error') {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'AI response missing valid status' })
      };
    }

    if (status === 'ok' && !analysisDoc) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'AI response missing analysis payload' })
      };
    }

    if (status === 'unclear' || status === 'error') {
      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          status,
          recordId: null
        })
      };
    }

    const recordPayload = {
      role,
      status,
      analysis: analysisDoc,
      discriminators,
      imageDataUrl: image,
      imageBytesEstimated: requestMeta.imageBytesEstimated,
      capturedAt,
      location,
      signature,
      reason,
      viewport,
      openAiRequestId,
      model: 'gpt-4o-mini'
    };

    let recordId = null;
    try {
      recordId = await persistAnalysisRecord(recordPayload, requestMeta);
    } catch (storageError) {
      return {
        statusCode: 500,
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          error: 'Failed to store analysis record',
          details: storageError?.message || 'Unknown storage error.'
        })
      };
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        status,
        analysis: analysisDoc,
        discriminators,
        recordId
      })
    };
  } catch (error) {
    console.error('Function error:', {
      message: error?.message,
      stack: error?.stack,
      requestMeta
    });
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message || 'Failed to run analysis' })
    };
  }
};

