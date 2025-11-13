// AI vision-based person matching using GPT-4o-mini
// Compares two photos to determine if they show the same person

import OpenAI from 'openai';
import { performVisionMatch } from './shared/vision-match.js';

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

      console.log('=== VISION MATCHING REQUEST ===');
      console.log('Photo 1 analysis:', photo1.analysis);
      console.log('Photo 2 analysis:', photo2.analysis);
      const result = await performVisionMatch(openai, photo1, photo2);

      console.log('=== VISION MATCHING RESULT ===');
      console.log('Similarity:', result.similarity);
      console.log('Confidence:', result.confidence);
      console.log('Reasoning:', result.reasoning);
      console.log('Fatal mismatch:', result.fatal_mismatch || 'none');
      console.log('Time difference:', result.timeDiffMinutes !== null ? `${result.timeDiffMinutes} min` : 'unknown');

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
          timeDiffMinutes: result.timeDiffMinutes
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
