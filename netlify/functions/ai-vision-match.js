// AI vision-based person matching using GPT-4o-mini
// Compares two photos to determine if they show the same person

import OpenAI from 'openai';

export const handler = async (event) => {
  // Only allow POST
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  try {
    const { photo1, photo2 } = JSON.parse(event.body);

    // Validate inputs
    if (!photo1?.imageDataUrl || !photo2?.imageDataUrl) {
      return {
        statusCode: 400,
        body: JSON.stringify({ 
          error: 'Missing required fields: photo1.imageDataUrl and photo2.imageDataUrl' 
        })
      };
    }

    if (!photo1.metadata || !photo2.metadata) {
      return {
        statusCode: 400,
        body: JSON.stringify({ 
          error: 'Missing metadata for photos' 
        })
      };
    }

    // Initialize OpenAI
    const openaiKey = process.env.OPENAI_API_KEY || process.env.OPENAIKEY;
    if (!openaiKey) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'OpenAI API key not configured' })
      };
    }

    const openai = new OpenAI({ apiKey: openaiKey });

    // Calculate time difference
    const time1 = photo1.capturedAt ? new Date(photo1.capturedAt) : null;
    const time2 = photo2.capturedAt ? new Date(photo2.capturedAt) : null;
    const timeDiffMinutes = (time1 && time2) 
      ? Math.abs(time2 - time1) / (1000 * 60) 
      : null;

    // Build prompt for AI
    const timeContext = timeDiffMinutes !== null 
      ? `Photos taken ${Math.round(timeDiffMinutes)} minutes apart.` 
      : 'Time difference unknown.';

    const prompt = `Compare these two photos to determine if they show the SAME PERSON.

CONTEXT:
${timeContext}
Both photos captured at similar location (event/gathering).
Person 1: ${photo1.metadata.gender}, ${photo1.metadata.ageRange} years old
Person 2: ${photo2.metadata.gender}, ${photo2.metadata.ageRange} years old

TASK:
Determine the probability (0-100%) that these are photos of the SAME PERSON.

CRITICAL RULES:
1. GENDER MISMATCH = 0% (instant fatal)
2. Photos taken close in time = outfit MUST be identical or nearly identical
3. Focus on OUTFIT as primary differentiator (colors, layers, accessories)
4. Age must be compatible (20-year gap = very unlikely same person)
5. Build/body type must align
6. Hair color and style must match
7. Small differences OK: gestures, facial expressions, camera angle
8. When uncertain, be conservative (better to separate than incorrectly merge)

COMPARISON PRIORITIES (in order):
1. Gender (must match)
2. Outfit colors and style (most distinctive)
3. Hair color and length
4. Accessories (jewelry, bags, glasses, items carried)
5. Build and height estimate
6. Age range compatibility

Return ONLY valid JSON with this exact structure:
{
  "similarity": <integer 0-100>,
  "confidence": <"high" | "medium" | "low">,
  "reasoning": "<brief explanation of match/mismatch>",
  "fatal_mismatch": <"gender" | "outfit" | "age" | null>
}

Examples:
- Same person, same outfit: {"similarity": 95, "confidence": "high", "reasoning": "Identical outfit, hair, and accessories", "fatal_mismatch": null}
- Similar people, different outfits: {"similarity": 15, "confidence": "high", "reasoning": "Different coat colors and accessories", "fatal_mismatch": "outfit"}
- Different gender: {"similarity": 0, "confidence": "high", "reasoning": "Male vs female", "fatal_mismatch": "gender"}`;

    console.log('=== VISION MATCHING REQUEST ===');
    console.log('Photo 1 metadata:', photo1.metadata);
    console.log('Photo 2 metadata:', photo2.metadata);
    console.log('Time difference:', timeDiffMinutes ? `${Math.round(timeDiffMinutes)} min` : 'unknown');

    // Call OpenAI Vision API
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'You are a person matching system. Analyze photos and return ONLY valid JSON with similarity score and reasoning.'
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { 
              type: 'image_url', 
              image_url: { 
                url: photo1.imageDataUrl,
                detail: 'low' // Use low detail to reduce cost while maintaining accuracy
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
      temperature: 0.1, // Low temperature for consistency
      max_tokens: 300
    });

    const result = JSON.parse(response.choices[0].message.content);

    console.log('=== VISION MATCHING RESULT ===');
    console.log('Similarity:', result.similarity);
    console.log('Confidence:', result.confidence);
    console.log('Reasoning:', result.reasoning);
    console.log('Fatal mismatch:', result.fatal_mismatch || 'none');

    // Validate response structure
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

