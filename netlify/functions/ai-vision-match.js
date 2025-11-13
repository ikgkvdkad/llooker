// AI vision-based person matching using GPT-4o-mini
// Compares two photos to determine if they show the same person

import OpenAI from 'openai';

function summariseSubject(subject = {}) {
  const gender = subject.gender || 'unknown-gender';
  const ageRange = subject.ageRange || subject.ageBucket || 'unknown-age';
  const build = subject.build || subject.bodyType || 'unknown-build';
  const skinTone = subject.skinTone || 'unknown-skin-tone';
  const hair = subject.hair || {};
  const hairSummary = [
    hair.length || null,
    hair.style || null,
    hair.color || null
  ].filter(Boolean).join('-') || 'unknown-hair';
  const eyewear = subject.eyewear || 'no-eyewear';
  const headwear = subject.headwear || 'no-headwear';
  const distinguishing = Array.isArray(subject.distinguishingFeatures) && subject.distinguishingFeatures.length
    ? subject.distinguishingFeatures.join('; ')
    : 'none';

  return `Gender: ${gender}. Age: ${ageRange}. Build: ${build}. Skin tone: ${skinTone}. Hair: ${hairSummary}. Eyewear: ${eyewear}. Headwear: ${headwear}. Distinguishing features: ${distinguishing}.`;
}

function summariseClothing(clothing = {}, accessories = {}, carriedItems = []) {
  const formatItem = (item = {}) => {
    if (!item || typeof item !== 'object') {
      return 'unknown';
    }
    const parts = [
      item.category || null,
      Array.isArray(item.colors) ? item.colors.join('+') : null,
      item.pattern || null,
      item.style || null
    ].filter(Boolean);
    return parts.length ? parts.join(' | ') : 'unknown';
  };

  const dominantColors = Array.isArray(clothing.dominantColors) && clothing.dominantColors.length
    ? clothing.dominantColors.join(', ')
    : 'unknown';

  const accessoriesSummary = Object.entries(accessories || {})
    .map(([bucket, values]) => Array.isArray(values) && values.length ? `${bucket}: ${values.join(', ')}` : null)
    .filter(Boolean)
    .join(' | ') || 'none';

  const carriedSummary = Array.isArray(carriedItems) && carriedItems.length
    ? carriedItems.join(', ')
    : 'none';

  return [
    `Dominant outfit colours: ${dominantColors}`,
    `Top: ${formatItem(clothing.top)}`,
    `Bottom: ${formatItem(clothing.bottom)}`,
    `Outerwear: ${formatItem(clothing.outerwear)}`,
    `Footwear: ${formatItem(clothing.footwear)}`,
    `Accessories: ${accessoriesSummary}`,
    `Carried items: ${carriedSummary}`
  ].join('\n');
}

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  try {
    const { photo1, photo2 } = JSON.parse(event.body);

    if (!photo1?.imageDataUrl || !photo2?.imageDataUrl) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: 'Missing required fields: photo1.imageDataUrl and photo2.imageDataUrl'
        })
      };
    }

    if (!photo1.analysis || !photo2.analysis) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: 'Missing analysis payload for photos'
        })
      };
    }

    const openaiKey = process.env.OPENAI_API_KEY || process.env.OPENAIKEY;
    if (!openaiKey) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'OpenAI API key not configured' })
      };
    }

    const openai = new OpenAI({ apiKey: openaiKey });

    const time1 = photo1.capturedAt ? new Date(photo1.capturedAt) : null;
    const time2 = photo2.capturedAt ? new Date(photo2.capturedAt) : null;
    const timeDiffMinutes = (time1 && time2)
      ? Math.abs(time2 - time1) / (1000 * 60)
      : null;

    const timeContext = timeDiffMinutes !== null
      ? `Photos taken ${Math.round(timeDiffMinutes)} minutes apart.`
      : 'Time difference unknown.';

    const subjectSummary1 = summariseSubject(photo1.analysis.subject);
    const subjectSummary2 = summariseSubject(photo2.analysis.subject);
    const outfitSummary1 = summariseClothing(
      photo1.analysis.clothing,
      photo1.analysis.accessories,
      photo1.analysis.carriedItems
    );
    const outfitSummary2 = summariseClothing(
      photo2.analysis.clothing,
      photo2.analysis.accessories,
      photo2.analysis.carriedItems
    );

    const discriminators1 = photo1.discriminators || {};
    const discriminators2 = photo2.discriminators || {};

    const prompt = `Compare these two photos to determine if they show the SAME PERSON.

CONTEXT:
${timeContext}
Photo 1 subject:
${subjectSummary1}
Photo 1 outfit:
${outfitSummary1}
Photo 1 discriminators: ${JSON.stringify(discriminators1)}

Photo 2 subject:
${subjectSummary2}
Photo 2 outfit:
${outfitSummary2}
Photo 2 discriminators: ${JSON.stringify(discriminators2)}

TASK:
Determine the probability (0-100%) that these are photos of the SAME PERSON.

CRITICAL RULES:
  1. Gender mismatch = 0% (fatal).
  2. Outfits captured within short time (~hours) must align in dominant colours, layers, and footwear.
  3. Hair colour/length/style and notable accessories must align.
  4. Build, age range, and skin tone must be compatible.
  5. Carried items or standout accessories are strong differentiators.
  6. When uncertain, be conservative (prefer false negative over false positive).

COMPARISON PRIORITIES (in order):
1. Gender
2. Outfit colours and layering
3. Hair style/colour
4. Accessories & carried items
5. Build/height category
6. Age range

Return ONLY valid JSON with this exact structure:
{
  "similarity": <integer 0-100>,
  "confidence": <"high" | "medium" | "low">,
  "reasoning": "<brief explanation of match/mismatch>",
  "fatal_mismatch": <"gender" | "outfit" | "age" | "hair" | "accessories" | null>
}

Examples:
- Identical person: {"similarity": 95, "confidence": "high", "reasoning": "Same gender, matching navy suit, identical shoes and glasses", "fatal_mismatch": null}
- Same build but outfit mismatch: {"similarity": 20, "confidence": "high", "reasoning": "Sweater vs bright red jacket and different shoes", "fatal_mismatch": "outfit"}
- Gender mismatch: {"similarity": 0, "confidence": "high", "reasoning": "Female vs male presentation", "fatal_mismatch": "gender"}`;

    console.log('=== VISION MATCHING REQUEST ===');
    console.log('Photo 1 analysis:', photo1.analysis);
    console.log('Photo 2 analysis:', photo2.analysis);
    console.log('Time difference:', timeDiffMinutes ? `${Math.round(timeDiffMinutes)} min` : 'unknown');

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'You are a re-identification assistant. Compare two cropped person photos and return ONLY valid JSON with similarity, confidence, reasoning, and fatal mismatch.'
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            {
              type: 'image_url',
              image_url: {
                url: photo1.imageDataUrl,
                detail: 'low'
              }
            },
            {
              type: 'image_url',
              image_url: {
                url: photo2.imageDataUrl,
                detail: 'low'
              }
            }
          ]
        }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.1,
      max_tokens: 350
    });

    const result = JSON.parse(response.choices[0].message.content);

    console.log('=== VISION MATCHING RESULT ===');
    console.log('Similarity:', result.similarity);
    console.log('Confidence:', result.confidence);
    console.log('Reasoning:', result.reasoning);
    console.log('Fatal mismatch:', result.fatal_mismatch || 'none');

    if (typeof result.similarity !== 'number' || result.similarity < 0 || result.similarity > 100) {
      console.error('Invalid similarity value:', result.similarity);
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'AI returned invalid similarity value' })
      };
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        similarity: Math.round(result.similarity),
        confidence: result.confidence || 'medium',
        reasoning: result.reasoning || 'No reasoning provided',
        fatal_mismatch: result.fatal_mismatch || null,
        timeDiffMinutes: timeDiffMinutes ? Math.round(timeDiffMinutes) : null
      })
    };
  } catch (error) {
    console.error('Vision matching error:', {
      message: error?.message,
      stack: error?.stack
    });

    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Vision matching failed',
        details: error?.message || 'Unknown error'
      })
    };
  }
};
