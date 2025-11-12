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

async function storeVectorEmbedding(recordId, embeddingText, metadata) {
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
    // Generate embedding from weighted text
    const embedding = await generateEmbedding(embeddingText, apiKey);

    if (!embedding || !Array.isArray(embedding) || embedding.length !== 1536) {
      throw new Error(`Invalid embedding dimensions: ${embedding?.length}`);
    }

    // Get index
    const index = pc.index(PINECONE_INDEX_NAME);

    // Prepare structured metadata for Pinecone
    const pineconeMetadata = {
      dbId: recordId.toString(),
      role: metadata.role || 'unknown',
      status: metadata.status || 'ok',
      capturedAt: metadata.capturedAt || new Date().toISOString(),
      createdAt: metadata.createdAt || new Date().toISOString()
    };

    // Add categorical metadata (for filtering)
    if (metadata.personMetadata) {
      pineconeMetadata.gender = metadata.personMetadata.gender || 'unknown';
      pineconeMetadata.ageRange = metadata.personMetadata.ageRange || 'unknown';
      pineconeMetadata.build = metadata.personMetadata.build || 'unknown';
      pineconeMetadata.skinTone = metadata.personMetadata.skinTone || 'unknown';
      pineconeMetadata.hairColor = metadata.personMetadata.hairColor || 'unknown';
    }

    // Add discriminative text (for reference, truncated)
    if (metadata.discriminative) {
      pineconeMetadata.discriminative = metadata.discriminative.substring(0, 500);
    }

    // Add description (for reference, truncated)
    if (metadata.description) {
      pineconeMetadata.description = metadata.description.substring(0, 500);
    }

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
      // Build weighted embedding text if metadata available
      let embeddingText = recordInput.description;
      
      if (recordInput.metadata && recordInput.discriminative) {
        const categorical = [
          recordInput.metadata.ageRange || '',
          recordInput.metadata.gender || '',
          recordInput.metadata.build || '',
          recordInput.metadata.skinTone || '',
          recordInput.metadata.hairColor || ''
        ].filter(Boolean).join(' ');
        
        // Extract OUTER/FIRST items from each category to repeat 3x
        const discriminativeParts = recordInput.discriminative.split(' ');
        const distinctiveParts = [];
        const baseParts = [];
        
        for (const part of discriminativeParts) {
          if (part.includes(':')) {
            const [key, value] = part.split(':');
            if (value && value !== 'none') {
              const items = value.split('+');
              if (items.length > 0) {
                distinctiveParts.push(`${key}:${items[0]}`);
                if (items.length > 1) {
                  baseParts.push(`${key}-base:${items.slice(1).join('+')}`);
                }
              }
            } else {
              distinctiveParts.push(part);
            }
          }
        }
        
        const distinctive = distinctiveParts.join(' ');
        const base = baseParts.join(' ');
        embeddingText = `${categorical} ${distinctive} ${distinctive} ${distinctive} ${base}`;
      }
      
      storeVectorEmbedding(insertedId, embeddingText, {
        role: recordInput.role,
        status: recordInput.status,
        personMetadata: recordInput.metadata,
        discriminative: recordInput.discriminative,
        description: recordInput.description,
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
             content: 'Return ONLY JSON with 3 fields: status, metadata, discriminative. ' +
               'If unclear: {"status":"unclear"} ' +
               'If OK: {"status":"ok","metadata":{"gender":"male","ageRange":"25-30","build":"average","skinTone":"light","hairColor":"brown"},"discriminative":"hair:short-brown face:none top:white-shirt bottom:blue-jeans shoes:sneakers accessories:watch carried:none"} ' +
               'DISCRIMINATIVE FORMAT RULES: ' +
               '1) MUST be string with format "hair:X face:Y top:Z bottom:W shoes:Q accessories:A carried:B" ' +
               '2) Use hyphens in values (gray-coat, black-boots) ' +
               '3) Use + for layers (coat+shirt, jacket+tie+shirt) ' +
               '4) NO COMMAS, NO PERIODS, NO PROSE ' +
               '5) All 7 keys REQUIRED: hair face top bottom shoes accessories carried (use "none" if not visible) ' +
               'Examples: ' +
               'discriminative:"hair:long-straight-red face:none top:gray-coat+black-turtleneck bottom:black-pants shoes:ankle-boots accessories:sunglasses carried:coffee" ' +
               'discriminative:"hair:short-wavy-brown face:beard top:denim-jacket+white-shirt bottom:jeans shoes:sneakers accessories:none carried:none"'
           },
           {
             role: 'user',
             content: [
               {
                 type: 'text',
                 text: 'Analyze person in photo. Return JSON: {"status":"ok","metadata":{gender,ageRange,build,skinTone,hairColor},"discriminative":"hair:X face:Y top:Z bottom:W shoes:Q accessories:A carried:B"}. ' +
                   'Use hyphens (ankle-boots), + for layers (coat+shirt). Include brands/patterns. NO commas/prose. Example: hair:shoulder-red face:none top:gray-coat+black-turtleneck bottom:black-pants shoes:ankle-boots accessories:sunglasses carried:coffee'
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
        max_tokens: 500,
        response_format: { type: "json_object" }
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
    const metadata = parsed?.metadata && typeof parsed.metadata === 'object' ? parsed.metadata : null;
    let discriminative = typeof parsed?.discriminative === 'string' ? parsed.discriminative.trim() : '';
    
    // Build simple description from metadata and discriminative
    let description = '';
    if (status === 'ok' && metadata && discriminative) {
      const metaParts = [
        metadata.ageRange,
        metadata.gender,
        metadata.build,
        metadata.skinTone,
        metadata.hairColor
      ].filter(Boolean).join(', ');
      description = `${metaParts}. ${discriminative.replace(/:/g, ': ').replace(/\+/g, ' + ')}`;
    } else if (status === 'unclear') {
      description = 'Unclear photo';
    }

    // DEBUG: Log what AI actually returned
    console.log('AI Response Parsed:', {
      status,
      discriminativeLength: discriminative.length,
      discriminativePreview: discriminative.substring(0, 150),
      metadata: metadata,
      generatedDescription: description.substring(0, 100)
    });

    // Validate discriminative format (must be key:value pairs)
    if (discriminative && status === 'ok') {
      // Check for required keys
      const hasRequiredKeys = discriminative.includes('hair:') && 
                              discriminative.includes('top:') && 
                              discriminative.includes('bottom:');
      
      // Check for forbidden characters (commas indicate prose format)
      const hasForbiddenChars = discriminative.includes(',') || 
                                 discriminative.includes('.') ||
                                 discriminative.includes('wearing') ||
                                 discriminative.includes('with');
      
      // Check format structure - should have multiple "key:" patterns
      const keyPattern = /\w+:/g;
      const keyMatches = discriminative.match(keyPattern);
      const hasEnoughKeys = keyMatches && keyMatches.length >= 5; // At least 5 keys
      
      const isValidFormat = hasRequiredKeys && !hasForbiddenChars && hasEnoughKeys;
      
      if (!isValidFormat) {
        console.error('AI returned invalid discriminative format:', {
          discriminative: discriminative.substring(0, 300),
          hasRequiredKeys,
          hasForbiddenChars,
          keyCount: keyMatches?.length || 0,
          requestMeta
        });
        return {
          statusCode: 500,
          body: JSON.stringify({ 
            error: 'AI returned invalid format - discriminative field must use key:value structure',
            details: 'Expected: "hair:X face:Y top:Z bottom:W shoes:Q accessories:A carried:C" with NO commas or prose',
            actualFormat: discriminative.substring(0, 150)
          })
        };
      }
      
      console.log('Discriminative format validated:', {
        length: discriminative.length,
        keyCount: keyMatches.length,
        preview: discriminative.substring(0, 100)
      });
    }

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

    // For 'ok' status, we expect structured data
    if (status === 'ok' && (!metadata || !discriminative)) {
      console.warn('AI response missing metadata or discriminative fields, using fallback', {
        hasMetadata: !!metadata,
        hasDiscriminative: !!discriminative,
        requestMeta
      });
    }

    const recordPayload = {
      role,
      status,
      description,
      metadata,
      discriminative,
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

    // Generate weighted embedding for similarity comparison
    // Only repeat OUTER/DISTINCTIVE layers to avoid shared base layer contamination
    let embedding = null;
    let embeddingText = description; // Fallback to full description
    
    if (status === 'ok' && metadata && discriminative) {
      // Build categorical part (1x)
      const categorical = [
        metadata.ageRange || '',
        metadata.gender || '',
        metadata.build || '',
        metadata.skinTone || '',
        metadata.hairColor || ''
      ].filter(Boolean).join(' ');
      
      // Extract OUTER/FIRST items from each category to repeat 3x
      // This prevents shared base layers (like "black-turtleneck") from dominating
      const discriminativeParts = discriminative.split(' ');
      const distinctiveParts = [];
      const baseParts = [];
      
      for (const part of discriminativeParts) {
        if (part.includes(':')) {
          const [key, value] = part.split(':');
          if (value && value !== 'none') {
            // Extract first item (outer layer) from multi-layered values
            const items = value.split('+');
            if (items.length > 0) {
              distinctiveParts.push(`${key}:${items[0]}`); // Outer layer only
              if (items.length > 1) {
                // Keep base layers separate (only once)
                baseParts.push(`${key}-base:${items.slice(1).join('+')}`);
              }
            }
          } else {
            distinctiveParts.push(part); // Keep "none" or empty
          }
        }
      }
      
      // Build weighted embedding: categorical 1x, distinctive 3x, base 1x
      const distinctive = distinctiveParts.join(' ');
      const base = baseParts.join(' ');
      embeddingText = `${categorical} ${distinctive} ${distinctive} ${distinctive} ${base}`;
      
      // DEBUG: Log what will be embedded
      console.log('Embedding Input:', {
        categorical,
        distinctive,
        base,
        totalEmbeddingLength: embeddingText.length,
        embeddingPreview: embeddingText.substring(0, 200)
      });
    }
    
    try {
      const openaiKey = process.env.OPENAI_API_KEY || process.env.OPENAIKEY;
      if (openaiKey) {
        embedding = await generateEmbedding(embeddingText, openaiKey);
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
        metadata: metadata || {},
        discriminative: discriminative || '',
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

