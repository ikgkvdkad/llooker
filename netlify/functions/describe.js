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
let poolInstance = null;
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

  const analysis = {
    subject: ensureObject(raw.subject),
    appearance: ensureObject(raw.appearance),
    clothing: ensureObject(raw.clothing),
    accessories: ensureObject(raw.accessories),
    carriedItems: normaliseStringList(raw.carriedItems),
    notes: ensureObject(raw.notes),
    confidence: ensureObject(raw.confidence),
    environment: ensureObject(raw.environment),
    tags: normaliseStringList(raw.tags)
  };

  const subject = analysis.subject;
  subject.distinguishingFeatures = normaliseStringList(subject.distinguishingFeatures);

  if (subject.hair && typeof subject.hair === 'object') {
    const hair = { ...subject.hair };
    ['color', 'length', 'style', 'coverage'].forEach((key) => {
      if (typeof hair[key] === 'string') {
        hair[key] = hair[key].trim().toLowerCase();
      } else {
        hair[key] = null;
      }
    });
    subject.hair = hair;
  } else {
    subject.hair = {};
  }

  const appearance = analysis.appearance;
  appearance.dominantColors = normaliseStringList(appearance.dominantColors);
  const palette = ensureObject(appearance.colorPalette);
  ['primary', 'secondary', 'accent'].forEach((key) => {
    if (typeof palette[key] === 'string') {
      palette[key] = palette[key].trim().toLowerCase();
    } else {
      palette[key] = null;
    }
  });
  appearance.colorPalette = palette;
  appearance.styleDescriptors = normaliseStringList(appearance.styleDescriptors);
  appearance.textureDescriptors = normaliseStringList(appearance.textureDescriptors);
  appearance.patterns = normaliseStringList(appearance.patterns);
  appearance.notableFeatures = normaliseStringList(appearance.notableFeatures);

  const clothingKeys = ['top', 'bottom', 'outerwear', 'footwear'];
  clothingKeys.forEach((key) => {
    const block = analysis.clothing[key];
    if (!block || typeof block !== 'object') {
      analysis.clothing[key] = {};
      return;
    }
    const clone = { ...block };
    ['category', 'pattern', 'style', 'fit', 'condition', 'layerOrder', 'material'].forEach((prop) => {
      if (typeof clone[prop] === 'string') {
        clone[prop] = clone[prop].trim().toLowerCase();
      } else {
        clone[prop] = null;
      }
    });
    clone.colors = normaliseStringList(clone.colors);
    clone.layers = normaliseStringList(clone.layers);
    clone.details = normaliseStringList(clone.details);
    analysis.clothing[key] = clone;
  });
  analysis.clothing.additionalLayers = normaliseStringList(analysis.clothing.additionalLayers);
  analysis.clothing.brandLogos = normaliseStringList(analysis.clothing.brandLogos);
  analysis.clothing.textOrGraphics = normaliseStringList(analysis.clothing.textOrGraphics);

  const accessories = analysis.accessories;
  const accessoryBuckets = ['jewelry', 'headwear', 'eyewear', 'handheld', 'bags', 'tech', 'other'];
  accessoryBuckets.forEach((bucket) => {
    accessories[bucket] = normaliseStringList(accessories[bucket]);
  });

  const notes = analysis.notes;
  notes.distinguishingMarks = normaliseStringList(notes.distinguishingMarks);
  notes.tattoos = normaliseStringList(notes.tattoos);
  notes.scars = normaliseStringList(notes.scars);
  notes.cosmetics = normaliseStringList(notes.cosmetics);
  notes.other = normaliseStringList(notes.other);

  const environment = analysis.environment;
  ['setting', 'background', 'lighting', 'crowdLevel', 'weather', 'cameraAngle'].forEach((key) => {
    if (typeof environment[key] === 'string') {
      environment[key] = environment[key].trim().toLowerCase();
    } else {
      environment[key] = null;
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

async function ensureTableExists(pool) {
  if (!pool) {
    throw new Error('Database pool not initialized.');
  }

  if (ensureTablePromise) {
    return ensureTablePromise;
  }

  const createTableSql = `
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

  ensureTablePromise = pool.query(createTableSql).catch((error) => {
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
        request_meta
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
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
      requestMeta ? JSON.stringify(requestMeta) : null
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
  'Return ONLY compact JSON with top-level fields: status, analysis, discriminators.',
  'status must be "ok", "unclear", or "error".',
  'analysis object MUST contain:',
  '  subject (gender, genderConfidence 0-1, ageRange, ageBucket, build, bodyType, heightCategory, skinTone, hair{color,length,style,coverage}, facialHair, eyewear, headwear, distinguishingFeatures[]),',
  '  appearance (dominantColors[], colorPalette{primary,secondary,accent}, styleDescriptors[], textureDescriptors[], patterns[], notableFeatures[]),',
  '  clothing (overallStyle, top, bottom, outerwear, footwear, additionalLayers[], brandLogos[], textOrGraphics[]).',
  'Each clothing item (top/bottom/outerwear/footwear) must include category, colors[], pattern, style, layerOrder, condition, fit.',
  'analysis.accessories must include buckets: jewelry[], headwear[], eyewear[], handheld[], bags[], tech[], other[].',
  'analysis.carriedItems array should list obvious objects being held or strapped.',
  'analysis.environment should describe setting, background, lighting, crowdLevel, weather, cameraAngle.',
  'analysis.notes should include distinguishingMarks[], tattoos[], scars[], cosmetics[], other[].',
  'analysis.confidence should provide numeric scores (0-1) for overall, gender, age, clothing, accessories, distinguishingFeatures.',
  'analysis.tags should be an array of hyphenated keywords (e.g., "formal-attire", "athletic").',
  'dominantColors MUST be lower-case basic colour words or hex codes (e.g., "navy-blue").',
  'discriminators must be an object with exactly: hair, face, top, bottom, footwear, accessories, carried.',
  'discriminator values must be hyphenated tokens with optional "+" for layers. No commas or prose sentences.',
  'If subject is unclear or not human: return {"status":"unclear"}',
  'If status is "ok" every required field must be filled with best-effort values; use "unknown" or empty arrays where detail is missing.',
  'Do NOT include any free-form description or explanation outside the JSON.'
].join(' ');

function buildUserPrompt(selectionInstruction) {
  return [
    'Analyze the visible person for metadata-driven re-identification.',
    'Return structured JSON as instructed by the system message.',
    'Pay attention to: gender cues, estimated age, body build, skin tone, hair colour/length/style, facial details (eyewear, facial hair, makeup, distinguishing marks).',
    'Capture clothing in detail: item categories, dominant and secondary colours, materials, notable patterns or logos, fit, and layering order.',
    'Record accessories such as bags, jewelry, headwear, eyewear, tech devices, handheld objects.',
    'List dominant colours across the outfit and specify hex or descriptive strings (navy-blue, burgundy, #8a2be2).',
    'Include environment cues that help disambiguate (indoor/outdoor, lighting, background type).',
    'Use hyphenated tokens (dark-blue, white-sneakers) and "+" when multiple layers are visible (jacket+hoodie+tee).',
    'If unsure about a field, set it to "unknown" or an empty array rather than omitting it.',
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
                  detail: 'high'
                }
              }
            ]
          }
        ],
        max_tokens: 900,
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

