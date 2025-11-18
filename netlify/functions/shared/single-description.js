const OPENAI_MODEL = 'gpt-4o-mini';
const GROUPING_MATCH_THRESHOLD = 60;

// Stable trait matching - these must be compatible for a match
const STABLE_TRAIT_THRESHOLD = 0.7; // 70% of stable traits must match

// Color equivalence groups for matching
const COLOR_EQUIVALENCE = [
  ['navy', 'dark_blue', 'blue'],
  ['dark_blonde', 'blonde', 'light_brown'],
  ['black', 'dark_brown', 'brown'] // allow some hair color variation
];

function colorsMatch(color1, color2) {
  if (!color1 || !color2 || color1 === 'unknown' || color2 === 'unknown') {
    return null; // can't compare
  }
  if (color1 === color2) {
    return true;
  }
  for (const group of COLOR_EQUIVALENCE) {
    if (group.includes(color1) && group.includes(color2)) {
      return true;
    }
  }
  return false;
}

function valuesMatch(val1, val2) {
  if (!val1 || !val2 || val1 === 'unknown' || val2 === 'unknown') {
    return null; // can't compare
  }
  return val1 === val2;
}

// Check if stable traits are compatible (no conflicts)
function checkStableCompatibility(schema1, schema2) {
  const checks = [];
  
  // Gender must match
  const genderMatch = valuesMatch(schema1.gender, schema2.gender);
  if (genderMatch === false) {
    return { compatible: false, reason: 'gender_mismatch', details: `${schema1.gender} vs ${schema2.gender}` };
  }
  if (genderMatch === true) checks.push('gender');
  
  // Hair color must be compatible
  const hairMatch = colorsMatch(schema1.hair_color, schema2.hair_color);
  if (hairMatch === false) {
    return { compatible: false, reason: 'hair_color_mismatch', details: `${schema1.hair_color} vs ${schema2.hair_color}` };
  }
  if (hairMatch === true) checks.push('hair_color');
  
  // Hair length should be compatible
  const hairLengthMatch = valuesMatch(schema1.hair_length, schema2.hair_length);
  if (hairLengthMatch === false) {
    return { compatible: false, reason: 'hair_length_mismatch', details: `${schema1.hair_length} vs ${schema2.hair_length}` };
  }
  if (hairLengthMatch === true) checks.push('hair_length');
  
  // Build should match
  const buildMatch = valuesMatch(schema1.build, schema2.build);
  if (buildMatch === false) {
    return { compatible: false, reason: 'build_mismatch', details: `${schema1.build} vs ${schema2.build}` };
  }
  if (buildMatch === true) checks.push('build');
  
  // Skin tone should match
  const skinMatch = valuesMatch(schema1.skin_tone, schema2.skin_tone);
  if (skinMatch === false) {
    return { compatible: false, reason: 'skin_tone_mismatch', details: `${schema1.skin_tone} vs ${schema2.skin_tone}` };
  }
  if (skinMatch === true) checks.push('skin_tone');
  
  // Age should be compatible (allow adjacent ranges)
  const age1 = schema1.age_range;
  const age2 = schema2.age_range;
  if (age1 && age2 && age1 !== 'unknown' && age2 !== 'unknown') {
    const ageOrder = ['18-24', '25-34', '35-44', '45-54', '55+'];
    const idx1 = ageOrder.indexOf(age1);
    const idx2 = ageOrder.indexOf(age2);
    if (idx1 >= 0 && idx2 >= 0) {
      if (Math.abs(idx1 - idx2) > 1) {
        return { compatible: false, reason: 'age_mismatch', details: `${age1} vs ${age2}` };
      }
      if (idx1 === idx2) checks.push('age');
    }
  }
  
  // Top color must match (core outfit)
  const topMatch = colorsMatch(schema1.top_color, schema2.top_color);
  if (topMatch === false) {
    return { compatible: false, reason: 'top_color_mismatch', details: `${schema1.top_color} vs ${schema2.top_color}` };
  }
  if (topMatch === true) checks.push('top_color');
  
  // Bottom color must match (core outfit)
  const bottomMatch = colorsMatch(schema1.bottom_color, schema2.bottom_color);
  if (bottomMatch === false) {
    return { compatible: false, reason: 'bottom_color_mismatch', details: `${schema1.bottom_color} vs ${schema2.bottom_color}` };
  }
  if (bottomMatch === true) checks.push('bottom_color');
  
  // Shoes color should match
  const shoesMatch = colorsMatch(schema1.shoes_color, schema2.shoes_color);
  if (shoesMatch === false) {
    return { compatible: false, reason: 'shoes_color_mismatch', details: `${schema1.shoes_color} vs ${schema2.shoes_color}` };
  }
  if (shoesMatch === true) checks.push('shoes_color');
  
  // Check bottom type (shorts vs pants is fatal)
  const bottom1 = (schema1.bottom_description || '').toLowerCase();
  const bottom2 = (schema2.bottom_description || '').toLowerCase();
  if (bottom1 && bottom2 && bottom1 !== 'unknown' && bottom2 !== 'unknown') {
    const isShorts1 = bottom1.includes('short');
    const isPants1 = bottom1.includes('pant') || bottom1.includes('jean') || bottom1.includes('trouser');
    const isSkirt1 = bottom1.includes('skirt');
    const isDress1 = bottom1.includes('dress');
    
    const isShorts2 = bottom2.includes('short');
    const isPants2 = bottom2.includes('pant') || bottom2.includes('jean') || bottom2.includes('trouser');
    const isSkirt2 = bottom2.includes('skirt');
    const isDress2 = bottom2.includes('dress');
    
    if ((isShorts1 && isPants2) || (isPants1 && isShorts2)) {
      return { compatible: false, reason: 'bottom_type_mismatch', details: `${bottom1} vs ${bottom2}` };
    }
    if ((isSkirt1 && !isSkirt2 && (isPants2 || isShorts2)) || (isSkirt2 && !isSkirt1 && (isPants1 || isShorts1))) {
      return { compatible: false, reason: 'bottom_type_mismatch', details: `${bottom1} vs ${bottom2}` };
    }
    if ((isDress1 && !isDress2 && (isPants2 || isShorts2)) || (isDress2 && !isDress1 && (isPants1 || isShorts1))) {
      return { compatible: false, reason: 'outfit_class_mismatch', details: `${bottom1} vs ${bottom2}` };
    }
  }
  
  return { compatible: true, matchedTraits: checks };
}

async function generateStablePersonDescription(imageDataUrl) {
  const apiKey = process.env.OPENAI_API_KEY || process.env.OPENAIKEY;

  if (!apiKey) {
    console.warn('OpenAI API key not configured; skipping description generation.');
    return null;
  }

  const prompt = `Describe the person in this photo for re-identification purposes.

Output ONLY valid JSON with this exact structure:

{
  "gender": "male|female|unknown",
  "age_range": "18-24|25-34|35-44|45-54|55+|unknown",
  "build": "slim|average|muscular|stocky|unknown",
  "height": "short|average|tall|unknown",
  "skin_tone": "very_light|light|medium|tan|brown|dark|unknown",
  "hair_color": "<normalized_color or 'unknown'>",
  "hair_length": "bald|buzz|very_short|short|medium|long|unknown",
  "hair_style": "<brief text or 'unknown'>",
  "facial_hair": "none|stubble|beard|mustache|goatee|unknown",
  "top_color": "<normalized_color or 'unknown'>",
  "top_description": "<brief text or 'unknown'>",
  "bottom_color": "<normalized_color or 'unknown'>",
  "bottom_description": "<brief text or 'unknown'>",
  "shoes_color": "<normalized_color or 'unknown'>",
  "shoes_description": "<brief text or 'unknown'>",
  "jacket_color": "<normalized_color or 'unknown'>",
  "jacket_description": "<brief text or 'unknown'>",
  "accessories": [
    {"type": "hat|glasses|bag|scarf|watch|jewelry|other", "description": "<text>", "removable": true|false}
  ],
  "distinctive_marks": [
    {"type": "tattoo|scar|birthmark", "description": "<text>", "location": "<body part>"}
  ],
  "image_clarity": 0-100,
  "natural_summary": "<3-4 sentence description>"
}

CRITICAL RULES:
1. Only name specific values for traits you can CLEARLY identify. If you cannot see or determine a trait, mark it as "unknown".
2. Do NOT guess or hedge. Be decisive based on what's actually visible.
3. If you can see a trait well enough to describe it in natural_summary, you MUST fill in the corresponding structured field with a specific value (not "unknown").
4. Normalized colors (use ONLY these): black, white, grey, navy, dark_blue, blue, light_blue, red, burgundy, green, olive, tan, beige, brown, dark_brown, light_brown, blonde, dark_blonde, auburn, ginger, pink, purple, yellow, orange, unknown
5. For clothing descriptions, be specific: "t-shirt", "button-up shirt", "polo", "jeans", "shorts", "sneakers", "dress shoes", etc.
6. accessories: mark removable=true for hats, bags, sunglasses, scarves; removable=false for tattoos, permanent jewelry
7. image_clarity: 0=unusable/blurry, 100=perfectly sharp and well-lit
8. natural_summary: 3-4 factual sentences describing appearance (no background, pose, or actions)

Produce ONLY the JSON. No other text.`;

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: 'You are a person re-identification descriptor. Extract structured traits from photos. Output ONLY valid JSON.'
          },
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
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
        max_tokens: 800,
        temperature: 0.1
      })
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      console.error('Description generation failed:', {
        status: response.status,
        body: errorText.slice(0, 400)
      });
      return null;
    }

    const data = await response.json();
    const rawContent = data?.choices?.[0]?.message?.content;
    const contentString = typeof rawContent === 'string' ? rawContent.trim() : '';
    if (!contentString) {
      console.warn('Description response was empty.');
      return null;
    }

    let schema;
    try {
      schema = JSON.parse(contentString);
    } catch (parseError) {
      console.error('Failed to parse description JSON:', {
        message: parseError?.message,
        contentPreview: contentString.slice(0, 400)
      });
      return null;
    }

    if (!schema || typeof schema !== 'object') {
      console.warn('Description schema missing or invalid.');
      return null;
    }

    // Validate required fields
    const required = ['gender', 'age_range', 'build', 'skin_tone', 'hair_color', 'hair_length', 
                      'top_color', 'bottom_color', 'shoes_color', 'natural_summary'];
    const missing = required.filter(key => !schema.hasOwnProperty(key));
    if (missing.length) {
      console.warn('Description schema missing required fields:', missing);
      return null;
    }

    const clarity = Number(schema.image_clarity);
    if (!Number.isFinite(clarity) || clarity < 0 || clarity > 100) {
      console.warn('image_clarity missing or invalid.');
      return null;
    }

    const naturalSummary = typeof schema.natural_summary === 'string' ? schema.natural_summary.trim() : '';
    if (!naturalSummary) {
      console.warn('natural_summary missing.');
      return null;
    }

    return {
      schema,
      naturalSummary
    };
  } catch (error) {
    console.error('Error generating description:', {
      message: error?.message,
      stack: error?.stack
    });
    return null;
  }
}

// Compute clarity based on how many traits are filled in with specific values
function computeSchemaClarity(schema) {
  if (!schema || typeof schema !== 'object') {
    return 0;
  }
  
  const baseClarity = Number(schema.image_clarity);
  if (!Number.isFinite(baseClarity)) {
    return 0;
  }
  
  // Count filled fields
  const fields = [
    schema.gender,
    schema.age_range,
    schema.build,
    schema.height,
    schema.skin_tone,
    schema.hair_color,
    schema.hair_length,
    schema.facial_hair,
    schema.top_color,
    schema.top_description,
    schema.bottom_color,
    schema.bottom_description,
    schema.shoes_color,
    schema.shoes_description
  ];
  
  const filled = fields.filter(v => v && v !== 'unknown').length;
  const total = fields.length;
  const completeness = (filled / total) * 100;
  
  // Blend base clarity with completeness
  return Math.round((baseClarity * 0.7) + (completeness * 0.3));
}

async function evaluateDescriptionGrouping(newSchema, existingGroups) {
  if (!newSchema || typeof newSchema !== 'object' || !Array.isArray(existingGroups) || !existingGroups.length) {
    return {
      bestGroupId: null,
      bestGroupProbability: 0,
      explanation: '',
      shortlist: []
    };
  }

  const candidates = [];
  
  for (const group of existingGroups) {
    if (!group || !group.group_canonical) continue;
    
    const canonical = group.group_canonical;
    const compatibility = checkStableCompatibility(newSchema, canonical);
    
    if (!compatibility.compatible) {
      candidates.push({
        groupId: group.group_id,
        memberCount: group.group_member_count || 0,
        compatible: false,
        reason: compatibility.reason,
        details: compatibility.details,
        matchedTraits: [],
        groupClarity: computeSchemaClarity(canonical)
      });
      continue;
    }
    
    // Count how many stable traits actually match
    const matchedTraits = compatibility.matchedTraits || [];
    const matchRatio = matchedTraits.length / 9; // 9 stable traits total
    
    candidates.push({
      groupId: group.group_id,
      memberCount: group.group_member_count || 0,
      compatible: true,
      matchedTraits,
      matchRatio,
      groupClarity: computeSchemaClarity(canonical)
    });
  }
  
  // Filter to compatible candidates with enough matches
  const viable = candidates.filter(c => c.compatible && c.matchRatio >= STABLE_TRAIT_THRESHOLD);
  
  if (!viable.length) {
    // Find best candidate for diagnostics
    const best = candidates.sort((a, b) => {
      if (a.compatible !== b.compatible) return b.compatible ? 1 : -1;
      return (b.matchRatio || 0) - (a.matchRatio || 0);
    })[0];
    
    let explanation = '';
    if (best && !best.compatible) {
      explanation = `Incompatible: ${best.reason} (${best.details})`;
    } else if (best) {
      explanation = `No group passed stable trait threshold. Best had ${best.matchedTraits.length}/9 stable traits matching (need ≥${Math.ceil(9 * STABLE_TRAIT_THRESHOLD)}).`;
    }
    
    return {
      bestGroupId: null,
      bestGroupProbability: 0,
      explanation,
      explanationDetails: best ? {
        reason: best.reason || 'insufficient_stable_matches',
        matchedTraits: best.matchedTraits || [],
        requiredMatches: Math.ceil(9 * STABLE_TRAIT_THRESHOLD)
      } : null,
      shortlist: [],
      bestCandidate: best || null
    };
  }
  
  // Sort by match ratio, then member count
  viable.sort((a, b) => {
    if (b.matchRatio !== a.matchRatio) return b.matchRatio - a.matchRatio;
    return b.memberCount - a.memberCount;
  });
  
  const shortlist = viable.slice(0, 3).map(c => ({
    groupId: c.groupId,
    matchedTraits: c.matchedTraits,
    matchRatio: Math.round(c.matchRatio * 100),
    memberCount: c.memberCount
  }));
  
  const top = viable[0];
  const explanation = `Stable traits compatible. ${top.matchedTraits.length}/9 stable traits matched. Sending to vision for verification.`;
  
  return {
    bestGroupId: null, // vision will decide
    bestGroupProbability: 0,
    explanation,
    explanationDetails: {
      matchedTraits: top.matchedTraits,
      matchRatio: Math.round(top.matchRatio * 100),
      requiredMatches: Math.ceil(9 * STABLE_TRAIT_THRESHOLD)
    },
    shortlist,
    bestCandidate: top
  };
}

module.exports = {
  generateStablePersonDescription,
  evaluateDescriptionGrouping,
  computeSchemaClarity,
  GROUPING_MATCH_THRESHOLD
};

