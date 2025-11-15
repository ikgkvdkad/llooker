const {
  getDatabasePool,
  ensureSingleCameraSelectionsTable,
  SINGLE_CAMERA_SELECTIONS_TABLE_NAME
} = require('./shared/db.js');

async function generateStablePersonDescription(imageDataUrl) {
  const apiKey = process.env.OPENAI_API_KEY || process.env.OPENAIKEY;

  if (!apiKey) {
    console.warn('OpenAI API key not configured; skipping description generation for single selection.');
    return null;
  }

  try {
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
              'You describe cropped person photos for re-identification.',
              'Write 3-4 short sentences that capture stable, visually obvious traits that are likely to remain unchanged over the next few hours.',
              'Focus on: apparent gender presentation, age range, build, height impression, skin tone, hair colour/length/style, facial hair, eyewear/headwear, visible tattoos or scars, and any distinctive accessories or garments.',
              'Ignore background, lighting, pose, facial expression, and guesses about personality or identity.',
              'Do not mention the time of day, camera perspective, or anything outside the person.',
              'Keep the description factual and concise so it can help decide if a later photo shows the same person.'
            ].join(' ')
          },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Describe the person in this cropped photo in 3-4 short sentences following the rules.'
              },
              {
                type: 'image_url',
                image_url: {
                  url: imageDataUrl,
                  detail: 'low'
                }
              }
            ]
          }
        ],
        max_tokens: 220,
        temperature: 0.2
      })
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      console.error('Single selection description request failed:', {
        status: response.status,
        body: errorText.slice(0, 400)
      });
      return null;
    }

    const data = await response.json();
    const rawContent = data?.choices?.[0]?.message?.content;
    const description = typeof rawContent === 'string' ? rawContent.trim() : '';
    if (!description) {
      console.warn('Single selection description response was empty.');
      return null;
    }

    // Hard cap to roughly 4 sentences by splitting on sentence terminators.
    const sentences = description
      .split(/(?<=[.!?])\s+/)
      .map(s => s.trim())
      .filter(Boolean)
      .slice(0, 4);

    return sentences.join(' ');
  } catch (error) {
    console.error('Error while generating single selection description:', {
      message: error?.message,
      stack: error?.stack
    });
    return null;
  }
}

function sanitizeViewport(viewport) {
  if (!viewport || typeof viewport !== 'object') {
    return null;
  }
  try {
    return JSON.parse(JSON.stringify(viewport));
  } catch {
    return null;
  }
}

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
    console.error('Failed to ensure single camera selections table:', error);
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

  const imageDataUrl = typeof payload?.imageDataUrl === 'string' ? payload.imageDataUrl : '';
  if (!imageDataUrl.startsWith('data:image/')) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'imageDataUrl must be a valid data URL.' })
    };
  }

  const viewport = sanitizeViewport(payload.viewport);
  const capturedAt = payload.capturedAt ? new Date(payload.capturedAt) : null;
  const signature = typeof payload.signature === 'string' ? payload.signature.slice(0, 512) : null;
  const mode = typeof payload.mode === 'string' ? payload.mode.trim().toLowerCase().slice(0, 32) : 'single';

  const description = await generateStablePersonDescription(imageDataUrl);

  const insertQuery = {
    text: `
      INSERT INTO ${SINGLE_CAMERA_SELECTIONS_TABLE_NAME} (role, image_data_url, viewport, signature, captured_at, description)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id, created_at, captured_at, role, description
    `,
    values: [
      mode || 'single',
      imageDataUrl,
      viewport ? JSON.stringify(viewport) : null,
      signature,
      capturedAt instanceof Date && !Number.isNaN(capturedAt.getTime()) ? capturedAt.toISOString() : null,
      description
    ]
  };

  try {
    const result = await pool.query(insertQuery);
    const record = result.rows?.[0];
    return {
      statusCode: 201,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        selection: {
          id: record?.id ?? null,
          createdAt: record?.created_at ?? null,
          capturedAt: record?.captured_at ?? null,
          role: record?.role ?? null,
          description: record?.description ?? null
        }
      })
    };
  } catch (error) {
    console.error('Failed to store single camera selection:', {
      message: error?.message,
      stack: error?.stack
    });
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Failed to store single selection.' })
    };
  }
};


