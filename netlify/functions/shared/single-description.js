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

async function evaluateDescriptionGrouping(newDescription, groups) {
  const apiKey = process.env.OPENAI_API_KEY || process.env.OPENAIKEY;

  if (!apiKey) {
    console.warn('OpenAI API key not configured; skipping grouping evaluation for single selection.');
    return {
      bestGroupId: null,
      bestGroupProbability: 0
    };
  }

  const filteredGroups = Array.isArray(groups)
    ? groups.filter(g => g && typeof g.id === 'number' && typeof g.description === 'string' && g.description.trim().length)
    : [];

  if (!filteredGroups.length || typeof newDescription !== 'string' || !newDescription.trim().length) {
    return {
      bestGroupId: null,
      bestGroupProbability: 0
    };
  }

  try {
    const requestPayload = {
      model: OPENAI_MODEL,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: [
            'You compare textual descriptions of people for re-identification.',
            'You are given a new description and a list of existing group descriptions.',
            'Use ONLY stable appearance traits (gender presentation, age range, build, height impression, skin tone, hair details, eyewear/headwear, distinctive clothing/accessories, visible tattoos or scars).',
            'Ignore differences that can change within a few hours (pose, facial expression, background, lighting, camera angle, small grooming or clothing adjustments).',
            'Be conservative: only consider someone the same person when appearance is very strongly aligned. Prefer false negatives over false positives.',
            'You must return ONLY a JSON object with two keys: "best_group_id" (the numeric id of the most likely matching group, or null if there is no suitable match) and "best_group_probability" (an integer 0-100 giving the probability that the new description belongs to that group).'
          ].join(' ')
        },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                new_description: newDescription,
                groups: filteredGroups.map(g => ({
                  id: g.id,
                  canonical_description: g.description
                }))
              })
            }
          ]
        }
      ]
    };

    console.log('=== single-grouping OPENAI request ===', JSON.stringify({
      newDescription,
      groups: filteredGroups,
      openaiPayload: requestPayload
    }, null, 2));

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(requestPayload)
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      console.error('Single selection grouping request failed:', {
        status: response.status,
        body: errorText.slice(0, 400)
      });
      return {
        bestGroupId: null,
        bestGroupProbability: 0
      };
    }

    const data = await response.json();
    console.log('=== single-grouping OPENAI raw response ===', JSON.stringify(data, null, 2));
    const content = data?.choices?.[0]?.message?.content;
    let parsed;
    try {
      parsed = typeof content === 'string' ? JSON.parse(content) : content;
    } catch {
      parsed = null;
    }

    if (!parsed || typeof parsed !== 'object') {
      console.warn('Grouping response was not valid JSON:', content);
      return {
        bestGroupId: null,
        bestGroupProbability: 0
      };
    }

    const bestGroupId = Number.isFinite(Number(parsed.best_group_id))
      ? Number(parsed.best_group_id)
      : null;
    const bestGroupProbability = Number.isFinite(Number(parsed.best_group_probability))
      ? Math.max(0, Math.min(100, Number(parsed.best_group_probability)))
      : 0;

    console.log('=== single-grouping parsed result ===', {
      bestGroupId,
      bestGroupProbability
    });

    return {
      bestGroupId,
      bestGroupProbability
    };
  } catch (error) {
    console.error('Error while evaluating single selection grouping:', {
      message: error?.message,
      stack: error?.stack
    });
    return {
      bestGroupId: null,
      bestGroupProbability: 0
    };
  }
}

module.exports = {
  generateStablePersonDescription,
  evaluateDescriptionGrouping
};

