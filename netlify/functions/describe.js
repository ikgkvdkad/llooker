const { Pool } = require('pg');
const { Pinecone } = require('@pinecone-database/pinecone');

const DEFAULT_TABLE_NAME = 'portrait_descriptions';
const PINECONE_INDEX_NAME = 'llooker2';

function resolveTableName() {
  const configured = process.env.DESCRIPTIONS_TABLE;
  if (!configured) {
    return DEFAULT_TABLE_NAME;
  }

  const sanitized = configured.trim();
  const isSafe = /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(sanitized);
  if (!isSafe) {
    console.warn('Invalid DESCRIPTIONS_TABLE provided. Falling back to default.', {
      provided: configured
    });
    return DEFAULT_TABLE_NAME;
  }

  return sanitized;
}

const TABLE_NAME = resolveTableName();
let poolInstance = null;
let ensureTablePromise = null;
let pineconeClient = null;

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

  const locationDoc = {
    status
  };

  if (locationInput.error && typeof locationInput.error === 'string') {
    locationDoc.error = locationInput.error;
  }

  const timestamp = convertToDate(locationInput.timestamp);
  if (timestamp) {
    locationDoc.timestamp = timestamp.toISOString();
  }

  if (locationInput.coords && typeof locationInput.coords === 'object') {
    const { latitude, longitude, accuracy, altitude, altitudeAccuracy, heading, speed } = locationInput.coords;

    if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
      locationDoc.coordinates = {
        latitude,
        longitude
      };
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

function getPineconeClient() {
  if (pineconeClient) {
    return pineconeClient;
  }

  const apiKey = process.env.PINECONEKEY || process.env.PINECONE_API_KEY;
  
  if (!apiKey) {
    console.warn('Pinecone API key not configured. Vector embeddings will not be stored.');
    return null;
  }

  try {
    pineconeClient = new Pinecone({
      apiKey: apiKey
    });
    return pineconeClient;
  } catch (error) {
    console.error('Failed to initialize Pinecone client:', error);
    return null;
  }
}

async function generateEmbedding(text, apiKey) {
  if (!text || typeof text !== 'string') {
    throw new Error('Invalid text for embedding generation');
  }

  const response = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'text-embedding-3-small',
      input: text,
      encoding_format: 'float'
    })
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`OpenAI Embedding API error: ${response.status} ${errorText}`);
  }

  const data = await response.json();
  return data.data[0].embedding;
}

async function storeVectorEmbedding(recordId, description, metadata) {
  const pc = getPineconeClient();
  
  if (!pc) {
    console.warn('Pinecone not configured. Skipping vector storage.');
    return null;
  }

  const apiKey = process.env.OPENAI_API_KEY || process.env.OPENAIKEY;
  
  if (!apiKey) {
    console.warn('OpenAI API key not configured. Cannot generate embeddings.');
    return null;
  }

  try {
    // Generate embedding from description text
    const embedding = await generateEmbedding(description, apiKey);

    if (!embedding || !Array.isArray(embedding) || embedding.length !== 1536) {
      throw new Error(`Invalid embedding dimensions: ${embedding?.length}`);
    }

    // Get index
    const index = pc.index(PINECONE_INDEX_NAME);

    // Prepare metadata (Pinecone has size limits, so we keep it concise)
    const pineconeMetadata = {
      dbId: recordId.toString(),
      description: description.substring(0, 1000), // Truncate to 1000 chars
      role: metadata.role || 'unknown',
      status: metadata.status || 'ok',
      capturedAt: metadata.capturedAt || new Date().toISOString(),
      createdAt: metadata.createdAt || new Date().toISOString()
    };

    // Add location if available
    if (metadata.location) {
      const loc = typeof metadata.location === 'string' 
        ? JSON.parse(metadata.location) 
        : metadata.location;
      
      if (loc.status === 'ok' && loc.coordinates) {
        pineconeMetadata.latitude = loc.coordinates.latitude;
        pineconeMetadata.longitude = loc.coordinates.longitude;
        pineconeMetadata.accuracy = loc.accuracy || null;
        pineconeMetadata.hasLocation = true;
      } else {
        pineconeMetadata.hasLocation = false;
      }
    } else {
      pineconeMetadata.hasLocation = false;
    }

    // Upsert to Pinecone
    await index.upsert([{
      id: `desc_${recordId}`,
      values: embedding,
      metadata: pineconeMetadata
    }]);

    console.log(`Successfully stored embedding for record ${recordId} in Pinecone`);
    return `desc_${recordId}`;

  } catch (error) {
    console.error('Failed to store vector embedding:', {
      message: error?.message,
      stack: error?.stack,
      recordId
    });
    // Don't fail the whole request if vector storage fails
    return null;
  }
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
      tone TEXT,
      description TEXT NOT NULL,
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

  ensureTablePromise = pool.query(createTableSql).catch((createError) => {
    ensureTablePromise = null;
    throw createError;
  });

  return ensureTablePromise;
}

async function persistDescriptionRecord(recordInput, requestMeta) {
  const pool = getDatabasePool();
  if (!pool) {
    throw new Error('Database is not configured. Set DATABASE_URL or NETLIFY_DATABASE_URL.');
  }

  try {
    await ensureTableExists(pool);
  } catch (tableError) {
    console.error('Failed to ensure descriptions table exists.', {
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
        tone,
        description,
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
      recordInput.tone || 'neutral',
      recordInput.description,
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
    const insertedId = result.rows?.[0]?.id ?? null;
    
    // Store vector embedding asynchronously (don't wait for it)
    if (insertedId && recordInput.status === 'ok') {
      storeVectorEmbedding(insertedId, recordInput.description, {
        role: recordInput.role,
        status: recordInput.status,
        capturedAt: capturedAtDate?.toISOString() || new Date().toISOString(),
        createdAt: new Date().toISOString(),
        location: locationDoc
      }).catch(err => {
        console.error('Vector embedding storage failed (non-blocking):', err);
      });
    }
    
    return insertedId;
  } catch (databaseError) {
    console.error('Failed to persist description record to database.', {
      message: databaseError?.message,
      stack: databaseError?.stack,
      tableName: TABLE_NAME,
      requestMeta
    });
    throw databaseError;
  }
}

exports.handler = async (event, context) => {
  // Only allow POST requests
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
    tone,
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
    tone,
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
    const selectionInstructionBase =
      'Focus exclusively on the individual within the selected area that has been extracted from the original image. The framing you see reflects the user\'s chosen view. Describe only the person visible in this extracted region.';
    const coordinateInstruction = normalizedSelection
      ? ` The normalized selection center (relative to the original image width and height) is approximately x=${normalizedSelection.x.toFixed(3)}, y=${normalizedSelection.y.toFixed(3)}.`
      : '';
    const selectionInstruction = `${selectionInstructionBase}${coordinateInstruction}`;

    // Check if API key is configured
    if (!apiKey) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'OpenAI API key not configured' })
      };
    }

    // Call OpenAI API
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
            content: [
              'You provide concise, descriptive observations of people in images using only concrete characteristics, without category labels or field names.',
              'Always assess only the individual within the selected area that has been extracted and submitted to you.',
              'If the selected area does not show a clearly discernible person—or the subject is distant, blurred, obstructed, poorly lit, or otherwise indiscernible—respond only with the JSON object {"status":"unclear","description":"Unclear photo"}.',
              'Otherwise respond with a single JSON object (no code block) shaped exactly as {"status":"ok","description":"[your description]"}.',
              'Your description must be 2-4 simple sentences listing only observable characteristics in this order: age range, gender, build, skin tone, hair details, clothing items with colors, footwear, notable accessories or features.',
              'Use plain language without labels, categories, or field names. Write as natural descriptive sentences.',
              'Example format: "25-30 years old, male, average build, light skin tone, short brown hair. Wearing blue jeans, white t-shirt, black leather jacket. Black sneakers, silver watch on left wrist. Casual appearance."',
              'Never use category labels like "Basics:", "Clothing:", "age:", "height:", "outermost layer:", etc. Only list the actual observations.',
              'Write "not visible" for specific details you cannot confirm, but do not use structural labels.',
              'Never guess identities, names, or personal data. Keep all details grounded in what is actually visible.'
            ].join(' ')
          },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: (
                  role === 'you'
                    ? 'Describe the person visible in the selected area from this "You" photo.'
                    : 'Describe the person visible in the selected area from this "Me" selfie.'
                ) + ' ' + selectionInstruction + ' If the subject is too far, obstructed, or blurred, reply with {"status":"unclear","description":"Unclear photo"}. Otherwise respond with {"status":"ok","description":"[2-4 sentences with age, gender, build, skin tone, hair, clothing colors and items, shoes, accessories]"}. Use only plain descriptive sentences without any category labels or field names. List only the actual observable characteristics.'
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
        max_tokens: 300
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
        body: JSON.stringify({ error: 'No description returned from OpenAI' })
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
    const description = typeof parsed?.description === 'string' ? parsed.description.trim() : '';

    if (status !== 'ok' && status !== 'unclear') {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'AI response missing valid status' })
      };
    }

    if (!description) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'AI response missing description' })
      };
    }

    const recordPayload = {
      role,
      status,
      description,
      tone: typeof tone === 'string' && tone.length ? tone : 'neutral',
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
      recordId = await persistDescriptionRecord(recordPayload, requestMeta);
    } catch (storageError) {
      return {
        statusCode: 500,
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          error: 'Failed to store description record',
          details: storageError?.message || 'Unknown storage error.'
        })
      };
    }

    // Generate embedding for similarity comparison (don't wait for Pinecone storage)
    let embedding = null;
    try {
      const openaiKey = process.env.OPENAI_API_KEY || process.env.OPENAIKEY;
      if (openaiKey) {
        embedding = await generateEmbedding(description, openaiKey);
      }
    } catch (embeddingError) {
      console.warn('Failed to generate embedding for response:', embeddingError);
      // Don't fail the request if embedding generation fails
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        status,
        description,
        embedding: embedding,
        recordId: recordId
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
      body: JSON.stringify({ error: error.message || 'Failed to get description' })
    };
  }
};

