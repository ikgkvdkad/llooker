const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

let firestoreInstance = null;

const DEFAULT_COLLECTION =
  process.env.FIREBASE_DESCRIPTIONS_COLLECTION || 'portraitDescriptions';

const SERVICE_ACCOUNT_FILENAME = 'firebase-service-account.json';
const SERVICE_ACCOUNT_PATH = path.join(__dirname, '..', SERVICE_ACCOUNT_FILENAME);

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

function normalizePrivateKey(rawKey) {
  if (!rawKey) return null;
  return rawKey.replace(/\\n/g, '\n');
}

function loadCredentialsFromFile() {
  if (!fs.existsSync(SERVICE_ACCOUNT_PATH)) {
    throw new Error(
      `Firestore service account file not found at ${SERVICE_ACCOUNT_PATH}.`
    );
  }

  const fileContents = fs.readFileSync(SERVICE_ACCOUNT_PATH, 'utf8');

  let parsed;
  try {
    parsed = JSON.parse(fileContents);
  } catch (parseError) {
    throw new Error(
      `Firestore service account file at ${SERVICE_ACCOUNT_PATH} is not valid JSON.`
    );
  }

  const projectId = parsed?.project_id;
  const clientEmail = parsed?.client_email;
  const privateKey = normalizePrivateKey(parsed?.private_key);

  const missingFields = [];
  if (!projectId) missingFields.push('project_id');
  if (!clientEmail) missingFields.push('client_email');
  if (!privateKey) missingFields.push('private_key');

  if (missingFields.length) {
    throw new Error(
      `Firestore service account file at ${SERVICE_ACCOUNT_PATH} is missing required field(s): ${missingFields.join(', ')}.`
    );
  }

  console.info('Loaded Firestore credentials from service account file.', {
    path: SERVICE_ACCOUNT_PATH
  });

  return { projectId, clientEmail, privateKey };
}

function resolveFirestoreCredentials() {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKeyRaw = process.env.FIREBASE_PRIVATE_KEY;

  const providedEnvValues = [projectId, clientEmail, privateKeyRaw].filter(
    (value) => typeof value === 'string' && value.trim().length > 0
  );

  if (providedEnvValues.length > 0 && providedEnvValues.length < 3) {
    throw new Error(
      'Firestore environment variables incomplete. Provide all of FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, and FIREBASE_PRIVATE_KEY.'
    );
  }

  if (projectId && clientEmail && privateKeyRaw) {
    return {
      projectId,
      clientEmail,
      privateKey: normalizePrivateKey(privateKeyRaw)
    };
  }

  return loadCredentialsFromFile();
}

function getFirestore() {
  if (firestoreInstance) {
    return firestoreInstance;
  }

  let credentials;
  try {
    credentials = resolveFirestoreCredentials();
  } catch (credentialError) {
    console.error('Firestore credential resolution failed.', {
      message: credentialError?.message,
      expectedFilePath: SERVICE_ACCOUNT_PATH
    });
    return null;
  }

  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(credentials)
    });
  }

  firestoreInstance = admin.firestore();
  return firestoreInstance;
}

function convertToTimestamp(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const Timestamp = admin.firestore.Timestamp;
  if (value instanceof Date) {
    return Timestamp.fromDate(value);
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Timestamp.fromMillis(value);
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) {
      return Timestamp.fromMillis(parsed);
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

  const timestamp = convertToTimestamp(locationInput.timestamp);
  if (timestamp) {
    locationDoc.timestamp = timestamp;
  }

  if (locationInput.coords && typeof locationInput.coords === 'object') {
    const { latitude, longitude, accuracy, altitude, altitudeAccuracy, heading, speed } = locationInput.coords;

    if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
      try {
        locationDoc.coordinates = new admin.firestore.GeoPoint(latitude, longitude);
      } catch (geoError) {
        console.error('Failed to build GeoPoint for location.', {
          message: geoError?.message,
          latitude,
          longitude
        });
      }
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

async function persistDescriptionRecord(recordInput, requestMeta) {
  const firestore = getFirestore();
  if (!firestore) {
    throw new Error('Firestore is not configured. Set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, and FIREBASE_PRIVATE_KEY.');
  }

  const FieldValue = admin.firestore.FieldValue;

  const docData = {
    role: recordInput.role || null,
    status: recordInput.status || null,
    description: recordInput.description,
    tone: recordInput.tone || 'neutral',
    imageDataUrl: recordInput.imageDataUrl,
    imageBytesEstimated: estimateImageBytesFromDataUrl(recordInput.imageDataUrl),
    reason: recordInput.reason || null,
    viewportSignature: recordInput.signature || null,
    viewport: recordInput.viewport || null,
    capturedAt: convertToTimestamp(recordInput.capturedAt) || FieldValue.serverTimestamp(),
    createdAt: FieldValue.serverTimestamp(),
    location: buildLocationDocument(recordInput.location),
    openAiRequestId: recordInput.openAiRequestId || null,
    model: recordInput.model || null
  };

  if (!docData.location) {
    delete docData.location;
  }

  const collectionName = DEFAULT_COLLECTION;

  try {
    const docRef = firestore.collection(collectionName).doc();
    await docRef.set(docData);
    return docRef.id;
  } catch (firestoreError) {
    console.error('Failed to persist description record.', {
      message: firestoreError?.message,
      stack: firestoreError?.stack,
      requestMeta
    });
    throw firestoreError;
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
    tone
  };

  try {
    if (!getFirestore()) {
      return {
        statusCode: 500,
        body: JSON.stringify({
          error: 'Firestore not configured. Set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, and FIREBASE_PRIVATE_KEY.'
        })
      };
    }

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
                'You provide richly detailed, respectful descriptions of people in images, focusing strictly on non-identifying physical and stylistic attributes.',
                'Always assess only the individual within the selected area that has been extracted and submitted to you. Focus on the person visible in this framed region.',
                'If the selected area does not show a clearly discernible person—or the subject is distant, blurred, obstructed, poorly lit, or otherwise indiscernible—respond only with the JSON object {"status":"unclear","description":"Unclear photo"}.',
                'Otherwise respond with a single JSON object (no code block) shaped exactly as {"status":"ok","description":"Basics: ...\\nClothing & Style: ...\\nAdditional Notes: ..."} and nothing else.',
                'Within Basics list, in order, apparent age range (or "not clearly visible"), apparent gender (or "not clearly visible"), build, height impression, posture, skin tone, and hairstyle or facial hair. Use concise witness-style phrases and write "not clearly visible" for any detail you cannot confirm.',
                'Within Clothing & Style summarize visible layers from outermost to innermost, including colors, textures, fit, footwear, and accessories. Always mention dominant colors and say "not clearly visible" when coverage is missing.',
                'Within Additional Notes add lighting, mood, notable props, or immediate context only when directly observed, and always note distinctive traits that help recognize the same person again (e.g., eye color, facial structure cues, scars, tattoos, piercings) when visible; write "not clearly visible" for any expected detail you cannot confirm, and use "none noted" only when no such observations apply.',
                'Never guess identities, names, or personal data. Keep clothing colors, textures, posture, lighting, and mood details accurate to what you can see, and always supply all three sections even when details are limited.'
              ].join(' ')
            },
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: (
                    role === 'you'
                      ? 'Describe only the person visible in the selected area from this "You" photo so an artist could recreate them.'
                      : 'Describe only the sender visible in the selected area from this "Me" selfie.'
                  ) + ' ' + selectionInstruction + ' Confirm that the selected area shows a clearly visible person; if the subject is too far, obstructed, or blurred to describe responsibly, reply with {"status":"unclear","description":"Unclear photo"}. When the subject is clear, respond with {"status":"ok","description":"Basics: ...\nClothing & Style: ...\nAdditional Notes: ..."} using that order and headings. In Basics, provide apparent age range, build, height impression, posture, skin tone, and hairstyle or facial hair; write "not clearly visible" for any detail you cannot confirm. In Clothing & Style, cover layers from outermost to innermost with colors, textures, fit, footwear, and accessories, noting "not clearly visible" when information is missing. In Additional Notes, give lighting, mood, or immediate context only if directly observed; otherwise write "none noted". Keep the description non-identifying and grounded in visible evidence.'
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
        capturedAt,
        location,
        signature,
        reason,
        viewport,
        openAiRequestId,
        model: 'gpt-4o-mini'
      };

      try {
        await persistDescriptionRecord(recordPayload, requestMeta);
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

      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          status,
          description
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
