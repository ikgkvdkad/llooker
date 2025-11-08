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

    // Check if API key is configured
    if (!process.env.OPENAIKEY) {
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
        'Authorization': `Bearer ${process.env.OPENAIKEY}`
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                  text: role === 'you' 
                    ? 'Describe the person in the photo as reference notes for an artist preparing to draw them. Include overall posture, proportions, facial structure, hair style and color, clothing with colors and textures, accessories, and lighting or mood cues. Highlight distinctive features and avoid speculating about their identity.'
                    : 'Describe the sender in the photo as reference notes for an artist preparing to draw them. Include overall posture, proportions, facial structure, hair style and color, clothing with colors and textures, accessories, and lighting or mood cues. Highlight distinctive features and avoid speculating about their identity.'
              },
              {
                type: 'image_url',
                image_url: { 
                  url: image,
                  detail: 'low' // Use low detail for faster/cheaper processing
                }
              }
            ]
          }
        ],
        max_tokens: 150
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
