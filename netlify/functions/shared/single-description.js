const OPENAI_MODEL = 'gpt-4o-mini';

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
        model: OPENAI_MODEL,
        messages: [
          {
            role: 'system',
            content: [
              'You describe cropped person photos for re-identification.',
              'Write 5-7 short sentences that capture stable, visually obvious traits that are likely to remain unchanged over the next few hours.',
              'Focus on: apparent gender presentation, age range, build, height impression, skin tone, hair colour/length/style, facial hair, eyewear/headwear, visible tattoos or scars, and any distinctive accessories or garments.',
              'Ignore background, lighting, pose, facial expression, and guesses about personality or identity.',
              'Do not mention the time of day, camera perspective, or anything outside the person.',
              'Keep the description factual and detailed enough to help decide if a later photo shows the same person.'
            ].join(' ')
          },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Describe the person in this cropped photo in 5-7 short sentences following the rules.'
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
        max_tokens: 380,
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

    // Hard cap to roughly 7 sentences by splitting on sentence terminators.
    const sentences = description
      .split(/(?<=[.!?])\s+/)
      .map(s => s.trim())
      .filter(Boolean)
      .slice(0, 7);

    return sentences.join(' ');
  } catch (error) {
    console.error('Error while generating single selection description:', {
      message: error?.message,
      stack: error?.stack
    });
    return null;
  }
}

module.exports = {
  generateStablePersonDescription
};


