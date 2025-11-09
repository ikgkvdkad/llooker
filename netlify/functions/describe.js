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

  const { role, image } = requestPayload;

  const requestMeta = {
    role: typeof role === 'string' ? role : null,
    imageProvided: typeof image === 'string',
    imageLength: typeof image === 'string' ? image.length : null,
    imageBytesEstimated: estimateImageBytesFromDataUrl(image)
  };

  try {
    if (!image) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'No image provided' })
      };
    }

    const apiKey = process.env.OPENAI_API_KEY || process.env.OPENAIKEY;

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
              content: 'You provide richly detailed, respectful descriptions of people in images. Focus on non-identifying, physical and stylistic attributes. Never guess identities, names, or personal data. If the intended subject is not clearly visible, respond exactly with: \"Unclear photo - unable to describe the central subject.\"'
            },
          {
            role: 'user',
            content: [
                {
                  type: 'text',
                    text: role === 'you'
                        ? 'Describe only the person whose body is closest to the crosshair at the exact center of this \"You\" photo so an artist could recreate them. First confirm that this central subject is clearly visible; if they are distant, poorly lit, blurred, or obscured, respond exactly with \"Unclear photo - unable to describe the central subject.\" When the subject is clear, focus on posture, physique, height impression, skin tone, hairstyle or facial hair, clothing layers (with colors, textures, and fit), footwear, accessories, and any lighting or mood cues that affect the subject. Mention the immediate context only if it helps position the subject, and avoid guessing age, name, identity, or traits that cannot be seen.'
                    : 'Describe only the sender taking this \"Me\" selfie so an artist could recreate them. Focus on posture, physique, height impression, skin tone, hairstyle or facial hair, clothing layers (with colors, textures, and fit), footwear, accessories, and any lighting or mood cues that affect the subject. Mention the immediate context only if it helps position the subject, and avoid guessing age, name, identity, or traits that cannot be seen.'
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

    if (!response.ok) {
      const errorText = await response.text();
      let openAiResponse;

      try {
        openAiResponse = JSON.parse(errorText);
      } catch {
        openAiResponse = null;
      }

      const openAiError = openAiResponse?.error;
      const openAiRequestId = response.headers.get('x-request-id')
        || response.headers.get('openai-request-id')
        || null;

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
    const description = data.choices?.[0]?.message?.content;

    if (!description) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'No description returned from OpenAI' })
      };
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ description })
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
