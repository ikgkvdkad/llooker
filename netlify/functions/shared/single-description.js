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
              'Write 10-14 short, clear sentences that capture stable, visually obvious traits that are likely to remain unchanged over the next few hours.', 
              'Focus on: apparent gender presentation, age range, build, height impression, skin tone, hair colour/length/style, facial hair, eyewear/headwear, visible tattoos or scars, and especially distinctive accessories or garments.', 
              'Pay special attention to small, rare visible details that would be unlikely to appear by chance on two different people, such as a specific logo placement, a unique print or pattern, a rip or stain in clothing, a distinctive piece of jewellery, or an unusual combination of garments.', 
              'Treat the presence of the same rare detail in two descriptions as strong evidence that these photos show the same person, but treat the absence of that detail in one description as weak evidence against a match.', 
              'Describe clothing colours as accurately as possible, mentally adjusting for plausible changes in lighting between photos when judging colour consistency.', 
              'Remember that some clothing items, like trousers/pants, distinctive jackets, and shoes, are less likely to change within a few hours than removable items like hats, sunglasses, or light accessories; highlight those more stable items clearly.', 
              'Ignore background, lighting, pose, facial expression, and guesses about personality or identity.', 
              'Do not mention the time of day, camera perspective, or anything outside the person.', 
              'Keep the description factual, specific, and detailed enough to help decide if a later photo shows the same person.'
            ].join(' ')
          },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Describe the person in this cropped photo in 10-14 short sentences following the rules.'
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
        max_tokens: 700,
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

    // Hard cap to roughly 14 sentences by splitting on sentence terminators.
    const sentences = description
      .split(/(?<=[.!?])\s+/)
      .map(s => s.trim())
      .filter(Boolean)
      .slice(0, 14);

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

  const normalizedGroups = Array.isArray(groups)
    ? groups
        .map(g => {
          if (!g) return null;
          const idNum = Number(g.id);
          const desc = typeof g.description === 'string' ? g.description.trim() : '';
          if (!Number.isFinite(idNum) || !desc) return null;
          return { id: idNum, description: desc };
        })
        .filter(Boolean)
    : [];

  if (!normalizedGroups.length || typeof newDescription !== 'string' || !newDescription.trim().length) {
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
              'You compare textual descriptions of people for re-identification. Your task is to decide whether a NEW description refers to the same person as one of the EXISTING group descriptions.',
              'Follow this comparison logic:',
              '1. Use only stable appearance traits. Allowed evidence: gender presentation, perceived age range, body build and height impression, skin tone, hair type/length/colour, stable clothing items (tops, trousers/pants, dresses, jackets/coats, shoes), and distinctive accessories (jewellery, tattoos, scars, patterns, logos). Ignore pose, expression, background, camera angle, image quality, vibe, attractiveness, posture, cropping.',
              '2. Clothing stability rule: Photos are taken within roughly an hour, so stable clothing items should match almost exactly. Accept minor wording differences (e.g., "navy blue jacket" vs "dark blue jacket"). Removable accessories (hats, sunglasses, scarves, bags, light outer layers) may differ and should not strongly penalize a match. Clothing is the primary anchor; accessories are secondary.',
              '3. Weighting hierarchy: (A) Rare/distinctive elements (unique prints/logos, unusual jewellery, tattoos, scars) are very strong positives when they match; missing a rare element is only weakly negative. (B) Core clothing match on stable pieces is extremely strong evidence; contradictory core clothing usually means different people unless a removable item is involved. (C) Physical traits (gender, age band, build, height, skin tone). (D) Semi-stable traits (hair style, hair accessories, temporary items).',
              '4. Normalisation rules: treat approximate wording and lighting tolerances as similar (e.g., "20s" vs "mid 20s", "dark blonde" vs "light brown-blonde", "navy" vs "dark blue"). Missing details count as unknown, not negative.',
              '5. Time-gap logic: With only ~1 hour between photos, clothing remains highly stable; accessories/hair can change slightly.',
              '6. Scoring rules: Give each group a similarity score from 0-100 reflecting likelihood of same person. 100 = extremely strong match, 0 = clearly different. If groups are close, prefer the one sharing more unique traits.',
              '7. Output format: Return ONLY JSON { "best_group_id": <id or null>, "best_group_probability": <integer 0-100>, "explanation": "<brief explanation of the key matching traits>" }. "best_group_id" must be the id with the highest score (or null if none). "best_group_probability" must be that score.',
              'Stay within these rules and never include additional keys.'
            ].join(' ')
          },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                new_description: newDescription,
                groups: normalizedGroups.map(g => ({
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
      groups: normalizedGroups,
      groupCount: normalizedGroups.length,
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
    const explanation = typeof parsed.explanation === 'string' ? parsed.explanation : '';

    console.log('=== single-grouping parsed result ===', {
      bestGroupId,
      bestGroupProbability,
      explanation
    });

    return {
      bestGroupId,
      bestGroupProbability,
      explanation
    };
  } catch (error) {
    console.error('Error while evaluating single selection grouping:', {
      message: error?.message,
      stack: error?.stack
    });
    return {
    bestGroupId: null,
    bestGroupProbability: 0,
    explanation: ''
    };
  }
}

module.exports = {
  generateStablePersonDescription,
  evaluateDescriptionGrouping
};

