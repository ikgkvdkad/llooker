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
                  ? 'Provide a detailed visual description. List each heading below and fill it with specific observations you can see. Do not guess or state the person\'s identity.\nTarget Overview: [overall appearance, approximate age range if evident, hair style/length/color]\nClothing & Accessories: [layers, colors, notable items such as hats, glasses, bags]\nPosture & Build: [stance, body orientation, build descriptors]\nSurroundings & Lighting: [location clues, lighting conditions, nearby objects]\nDistinctive Cues: [visible features that would help distinguish this person in a group]'
                  : 'Provide a detailed visual description of this selfie. List each heading below and fill it with specific observations you can see. Do not guess or state the person\'s identity.\nSender Overview: [overall appearance, hairstyle, visible facial hair or eyewear]\nClothing & Accessories: [garments, colors, jewelry, tech devices]\nPose & Expression: [posture, framing, gestures, facial expression]\nBackground Context: [environment details, lighting, visible objects]\nDistinctive Cues: [visible features that would help distinguish this person in a group]'
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
