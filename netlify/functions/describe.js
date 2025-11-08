exports.handler = async (event, context) => {
  // Only allow POST requests
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  try {
    const { role, image } = JSON.parse(event.body);

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
            content: 'You provide richly detailed, respectful descriptions of people in images. Focus on non-identifying, physical and stylistic attributes. Never guess identities, names, or personal data.'
          },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: role === 'you'
                  ? 'Provide a “wine label” style description of the entire image and everyone in it so an artist could recreate you. Include scene layout, posture, physique, height impression, skin tone, hair style and facial hair, clothing layers with colors and textures, footwear, accessories, and lighting or mood cues. Only state observable attributes; do not guess age, name, identity, or unseen traits.'
                  : 'Provide a “wine label” style description of the entire image and everyone in it so an artist could recreate the sender. Include scene layout, posture, physique, height impression, skin tone, hair style and facial hair, clothing layers with colors and textures, footwear, accessories, and lighting or mood cues. Only state observable attributes; do not guess age, name, identity, or unseen traits.'
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
      const errorData = await response.text();
      console.error('OpenAI API error:', errorData);
      return {
        statusCode: response.status,
        body: JSON.stringify({ error: `OpenAI API error: ${response.statusText}` })
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
    console.error('Function error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message || 'Failed to get description' })
    };
  }
};
