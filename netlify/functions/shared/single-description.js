const OPENAI_MODEL = 'gpt-4o-mini';
// Threshold for attaching a selection to an existing person group.
// Aligned with the deterministic MERGE_THRESHOLD in evaluateDescriptionGrouping.
const GROUPING_MATCH_THRESHOLD = 60;

// Shared scoring constants for deterministic grouping and neighbor scoring.
const WEIGHT_RARE = 40;
const WEIGHT_CLOTHING = 35;
const WEIGHT_PHYSICAL = 12;
const WEIGHT_HAIR = 8;
const LOCATION_MATCH_BONUS = 8;
const RARE_MISSING_PENALTY = -6;
const TIE_DELTA = 6;

const COLOR_EQUIVALENCE_GROUPS = [
  ['navy', 'dark_blue', 'blue'],
  ['dark_blonde', 'blonde', 'light_brown']
];

function effectiveConfidence(newConfidence, groupConfidence) {
  const nc = Number(newConfidence);
  const gc = Number(groupConfidence);
  if (!Number.isFinite(nc) || !Number.isFinite(gc)) {
    return 0;
  }
  return Math.max(0, Math.min(1, (nc / 100) * (gc / 100)));
}

function areColorsEquivalent(c1, c2, lightingUncertainty) {
  if (!c1 || !c2 || c1 === 'unknown' || c2 === 'unknown') {
    return false;
  }
  if (c1 === c2) {
    return true;
  }
  const lu = Number(lightingUncertainty) || 0;
  for (const group of COLOR_EQUIVALENCE_GROUPS) {
    if (group.includes(c1) && group.includes(c2)) {
      if (c1 !== c2 && lu > 50) {
        return true;
      }
      return true;
    }
  }
  return false;
}

function substringTokenMatch(s1, s2) {
  if (!s1 || !s2 || s1 === 'unknown' || s2 === 'unknown') {
    return false;
  }
  const tokens = String(s1).toLowerCase().split(/\s+/).filter(Boolean);
  const haystack = String(s2).toLowerCase();
  return tokens.some((tok) => haystack.includes(tok));
}

function ageAdjacent(a, b) {
  const order = ['18-24', '25-34', '35-44', '45-54', '55+'];
  const ia = order.indexOf(a);
  const ib = order.indexOf(b);
  if (ia === -1 || ib === -1) return false;
  return Math.abs(ia - ib) === 1;
}

function computeDistinctiveBonus(newSchema, groupCanonical) {
  const marks = Array.isArray(groupCanonical.distinctive_marks) ? groupCanonical.distinctive_marks : [];
  const newMarks = Array.isArray(newSchema.distinctive_marks) ? newSchema.distinctive_marks : [];
  let sum = 0;
  for (const gm of marks) {
    const rarity = Number(gm?.rarity_score);
    if (!Number.isFinite(rarity) || rarity < 1) continue;
    const gmDesc = typeof gm.description === 'string' ? gm.description : '';
    const gmType = gm.type || null;
    const gmConf = Number(gm.confidence) || 100;
    for (const nm of newMarks) {
      if (!nm || typeof nm !== 'object') continue;
      if (gmType && nm.type && gmType !== nm.type) continue;
      if (!substringTokenMatch(nm.description, gmDesc)) continue;
      const econf = effectiveConfidence(nm.confidence, gmConf);
      if (econf <= 0) continue;
      sum += (rarity * econf);
    }
  }
  return Math.min(5, sum / 20);
}

function buildExplanation(contrib) {
  const parts = [];
  if (contrib.A > 0) {
    parts.push('distinctive marks');
  }
  if (contrib.B > 0) {
    parts.push('clothing');
  }
  if (contrib.C > 0) {
    parts.push('physical traits');
  }
  if (contrib.D > 0) {
    parts.push('hair');
  }
  if (!parts.length) {
    return 'No strong matching features.';
  }
  const used = parts.slice(0, 3);
  return `Matched ${used.join(', ')}.`;
}

function scoreAgainstGroup(newSchema, groupCanonical) {
  let A = 0;
  let B = 0;
  let C = 0;
  let D = 0;

  const newMarks = Array.isArray(newSchema.distinctive_marks) ? newSchema.distinctive_marks : [];
  const groupMarks = Array.isArray(groupCanonical.distinctive_marks) ? groupCanonical.distinctive_marks : [];
  const groupClothing = groupCanonical.clothing && typeof groupCanonical.clothing === 'object'
    ? groupCanonical.clothing
    : {};
  const newClothing = newSchema.clothing && typeof newSchema.clothing === 'object'
    ? newSchema.clothing
    : {};

  const rareSources = [
    ...groupMarks,
    ...Object.values(groupClothing || {}).filter((item) => item && typeof item === 'object' && item.rare_flag)
  ];

  for (const gm of rareSources) {
    if (!gm || typeof gm !== 'object') continue;
    const rarity = Number(gm.rarity_score);
    if (!Number.isFinite(rarity) || rarity < 60) continue;
    const gmDesc = typeof gm.description === 'string' ? gm.description : '';
    const gmType = gm.type || null;
    const gmLocation = gm.location || null;
    const gmConf = Number(gm.confidence) || 100;

    let matched = null;
    for (const nm of newMarks) {
      if (!nm || typeof nm !== 'object') continue;
      if (gmType && nm.type && gmType !== nm.type) continue;
      if (!substringTokenMatch(nm.description, gmDesc)) continue;
      matched = nm;
      break;
    }

    if (matched) {
      const econf = effectiveConfidence(matched.confidence, gmConf);
      if (econf > 0) {
        let points = WEIGHT_RARE * (rarity / 100) * econf;
        const nmLocation = matched.location || null;
        if ((gmLocation && nmLocation && gmLocation === nmLocation) || (!gmLocation && !nmLocation)) {
          points += LOCATION_MATCH_BONUS * econf;
        }
        A += points;
      }
    } else {
      const missingRare = newMarks.some((nm) => {
        if (!nm || typeof nm !== 'object') return false;
        if (gmType && nm.type && gmType !== nm.type) return false;
        return nm.description === 'unknown' && Number(nm.confidence) >= 80;
      });
      if (missingRare) {
        A -= Math.abs(RARE_MISSING_PENALTY) * (rarity / 100);
      }
    }
  }

  if (A > WEIGHT_RARE) A = WEIGHT_RARE;

  const lightingUncertainty = Number(newSchema.lighting_uncertainty) || 0;
  const clothingSlots = ['top', 'jacket', 'trousers', 'shoes', 'dress'];
  for (const slot of clothingSlots) {
    const newSlot = newClothing[slot];
    const groupSlot = groupClothing[slot];
    if (!newSlot || !groupSlot || typeof newSlot !== 'object' || typeof groupSlot !== 'object') {
      continue;
    }
    if (newSlot.description === 'unknown' || groupSlot.description === 'unknown') {
      continue;
    }
    const colorOk = areColorsEquivalent(newSlot.color, groupSlot.color, lightingUncertainty);
    const descOk = substringTokenMatch(newSlot.description, groupSlot.description);
    const colorScore = colorOk ? 1 : 0;
    const descScore = descOk ? 1 : 0;
    let raw = (colorScore * 0.6) + (descScore * 0.4);
    if (raw <= 0) continue;

    let permMult = 1;
    const newPerm = newSlot.permanence;
    const groupPerm = groupSlot.permanence;
    if (newPerm === 'removable' || groupPerm === 'removable') {
      permMult = 0.3;
    } else if (newPerm === 'possibly_removable' || groupPerm === 'possibly_removable') {
      permMult = 0.6;
    }

    const econf = effectiveConfidence(newSlot.confidence, groupSlot.confidence);
    if (econf <= 0) continue;

    const slotPoints = WEIGHT_CLOTHING * raw * permMult * econf;
    B += slotPoints;
  }
  if (B > WEIGHT_CLOTHING) B = WEIGHT_CLOTHING;

  const physFields = ['gender_presentation', 'age_band', 'build', 'height_impression', 'skin_tone'];
  const subWeight = WEIGHT_PHYSICAL / physFields.length;
  for (const field of physFields) {
    const newField = newSchema[field];
    const groupField = groupCanonical[field];
    if (!newField || !groupField || typeof newField !== 'object' || typeof groupField !== 'object') {
      continue;
    }
    const nv = newField.value;
    const gv = groupField.value;
    if (!nv || !gv || nv === 'unknown' || gv === 'unknown') {
      continue;
    }
    const econf = effectiveConfidence(newField.confidence, groupField.confidence);
    if (econf <= 0) continue;

    if (nv === gv) {
      C += subWeight * 1 * econf;
    } else if (field === 'age_band' && ageAdjacent(nv, gv)) {
      C += subWeight * 0.5 * econf;
    } else {
      C -= subWeight * 0.35 * econf;
    }
  }
  if (C < 0) C = 0;
  if (C > WEIGHT_PHYSICAL) C = WEIGHT_PHYSICAL;

  const hairNew = newSchema.hair && typeof newSchema.hair === 'object' ? newSchema.hair : null;
  const hairGroup = groupCanonical.hair && typeof groupCanonical.hair === 'object' ? groupCanonical.hair : null;
  if (hairNew && hairGroup) {
    const newColor = hairNew.color || {};
    const groupColor = hairGroup.color || {};
    if (newColor.value !== 'unknown' && groupColor.value !== 'unknown') {
      if (areColorsEquivalent(newColor.value, groupColor.value, lightingUncertainty)) {
        const econf = effectiveConfidence(newColor.confidence, groupColor.confidence);
        if (econf > 0) {
          D += 0.5 * WEIGHT_HAIR * econf;
        }
      }
    }

    const newLength = hairNew.length || {};
    const groupLength = hairGroup.length || {};
    if (newLength.value && groupLength.value && newLength.value !== 'unknown' && groupLength.value !== 'unknown' && newLength.value === groupLength.value) {
      const econf = effectiveConfidence(newLength.confidence, groupLength.confidence);
      if (econf > 0) {
        D += 0.3 * WEIGHT_HAIR * econf;
      }
    }

    const newStyle = hairNew.style || {};
    const groupStyle = hairGroup.style || {};
    if (substringTokenMatch(newStyle.value, groupStyle.value)) {
      const econf = effectiveConfidence(newStyle.confidence, groupStyle.confidence);
      if (econf > 0) {
        D += 0.1 * WEIGHT_HAIR * econf;
      }
    }

    const newFacial = hairNew.facial_hair || {};
    const groupFacial = hairGroup.facial_hair || {};
    if (newFacial.value && groupFacial.value && newFacial.value !== 'unknown' && groupFacial.value !== 'unknown' && newFacial.value === groupFacial.value) {
      const econf = effectiveConfidence(newFacial.confidence, groupFacial.confidence);
      if (econf > 0) {
        D += 0.1 * WEIGHT_HAIR * econf;
      }
    }
  }
  if (D > WEIGHT_HAIR) D = WEIGHT_HAIR;

  const bonus = computeDistinctiveBonus(newSchema, groupCanonical);

  let rawScore = A + B + C + D + bonus;
  const visibleConfidence = Number(newSchema.visible_confidence) || 0;
  if (visibleConfidence < 30) {
    rawScore -= 10;
  }
  if (!Number.isFinite(rawScore)) {
    rawScore = 0;
  }
  if (rawScore < 0) rawScore = 0;
  if (rawScore > 100) rawScore = 100;

  const finalScore = Math.round(rawScore);
  const explanation = buildExplanation({ A, B, C, D });

  return {
    score: finalScore,
    explanation,
    distinctiveBonus: bonus
  };
}

/**
 * Score a structured description against many canonical group descriptions.
 * Returns a sorted array of scored groups, highest score first.
 */
function scoreDescriptionAgainstGroups(newDescriptionSchema, existingGroups) {
  if (!newDescriptionSchema || typeof newDescriptionSchema !== 'object' || !Array.isArray(existingGroups) || !existingGroups.length) {
    return [];
  }

  const scoredGroups = [];
  for (const group of existingGroups) {
    if (!group || typeof group !== 'object') continue;
    const canonical = group.group_canonical;
    if (!canonical || typeof canonical !== 'object') continue;
    const groupId = group.group_id;
    const memberCount = Number(group.group_member_count) || 0;
    const { score, explanation, distinctiveBonus } = scoreAgainstGroup(newDescriptionSchema, canonical);
    scoredGroups.push({
      groupId,
      memberCount,
      score,
      explanation,
      distinctiveBonus
    });
  }

  scoredGroups.sort((a, b) => b.score - a.score);
  return scoredGroups;
}

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
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: [
              'You are a descriptor that turns a single cropped photo of a person into a machine-readable structured description plus a short natural-language summary.',
              'Output must be valid JSON matching the description_schema below, and nothing else.',
              'Each numeric field must be an integer.',
              'Use the standardized vocabularies specified.',
              'Do not include analysis or extra text.',
              'If a value is not visible, use the explicit string "unknown".',
              'For each trait include a confidence integer 0–100 (0 = no confidence, 100 = certain).',
              'For clothing and accessories include a permanence value which must be one of "stable", "possibly_removable", or "removable".',
              'For distinctive marks, include rarity_score 0–100 (0 = common, 100 = unique).',
              'At the end, include natural_summary — a 10–14 short-sentence human readable description that follows earlier guidelines (factual, no background/pose).',
              'Follow the description_schema exactly.'
            ].join(' ')
          },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: [
                  'Describe the person in this cropped photo. Produce only JSON that matches this schema:',
                  '',
                  '{',
                  '  "description_schema": {',
                  '    "visible_area": "one of [\\"head_torso\\", \\"full_body\\", \\"upper_body\\", \\"head_only\\", \\"lower_body\\"]",',
                  '    "gender_presentation": {"value": "male|female|androgynous|unknown", "confidence": 0-100},',
                  '    "age_band": {"value": "18-24|25-34|35-44|45-54|55+", "confidence": 0-100},',
                  '    "build": {"value": "slim|average|muscular|stocky|unknown", "confidence": 0-100},',
                  '    "height_impression": {"value": "short|average|tall|unknown", "confidence": 0-100},',
                  '    "skin_tone": {"value": "very_light|light|medium|tan|brown|dark|unknown", "confidence": 0-100},',
                  '    "hair": {',
                  '      "color": {"value": "<one of normalized colors>", "confidence": 0-100},',
                  '      "length": {"value": "buzz|very_short|short|medium|long|unknown", "confidence": 0-100},',
                  '      "style": {"value": "<short text up to 6 words or \'unknown\'>", "confidence": 0-100},',
                  '      "facial_hair": {"value": "none|stubble|beard|mustache|goatee|unknown", "confidence": 0-100}',
                  '    },',
                  '    "clothing": {',
                  '      "top": {"description":"<text or \'unknown\'>","color":"<normalized color or \'unknown\'>","permanence":"stable|possibly_removable|removable","confidence":0-100,"rare_flag":true|false},',
                  '      "jacket": {"description":"<text or \'unknown\'>","color":"<normalized color or \'unknown\'>","permanence":"stable|possibly_removable|removable","confidence":0-100,"rare_flag":true|false},',
                  '      "trousers": {"description":"<text or \'unknown\'>","color":"<normalized color or \'unknown\'>","permanence":"stable|possibly_removable|removable","confidence":0-100,"rare_flag":true|false},',
                  '      "shoes": {"description":"<text or \'unknown\'>","color":"<normalized color or \'unknown\'>","permanence":"stable|possibly_removable|removable","confidence":0-100,"rare_flag":true|false},',
                  '      "dress": {"description":"<text or \'unknown\'>","color":"<normalized color or \'unknown\'>","permanence":"stable|possibly_removable|removable","confidence":0-100,"rare_flag":true|false}',
                  '    },',
                  '    "accessories": [',
                  '      {"type":"hat|glasses|bag|scarf|necklace|ring|watch|other","description":"<text or \'unknown\'>","location":"<left/right/neck/hand/unknown>","permanence":"stable|possibly_removable|removable","confidence":0-100,"rare_flag":true|false}',
                  '    ],',
                  '    "distinctive_marks": [',
                  '      {"type":"tattoo|scar|stain|logo|tear|unique_print|other","description":"<text>","location":"<left chest|right sleeve|left thigh|back|face|hand|unknown>","rarity_score":0-100,"confidence":0-100}',
                  '    ],',
                  '    "distinctiveness_score": 0-100,',
                  '    "lighting_uncertainty": 0-100,',
                  '    "visible_confidence": 0-100,',
                  '    "natural_summary":"<10-14 short sentences>"',
                  '  }',
                  '}',
                  '',
                  'Normalized color vocabulary (only these strings):',
                  'black, white, grey, navy, dark_blue, blue, light_blue, red, burgundy, green, olive, tan, beige, brown, blonde, dark_blonde, light_brown, auburn, chestnut, ginger, pink, purple, unknown',
                  '',
                  'Use "unknown" explicitly for traits not visible. Omitting keys is not allowed.',
                  'permanence: if an item is unlikely to change within 1 hour (trousers, shoes, heavy jacket) mark stable; scarves, hats, sunglasses commonly possibly_removable or removable.',
                  'rare_flag must be true if the item is visually unusual (unique logo, clear tear, unusual pattern placement, distinctive jewellery).',
                  'distinctiveness_score = 0–100 summary of how many high-confidence unique cues exist (0 none, 100 many unique high-confidence cues).',
                  'lighting_uncertainty = 0 if color is clear, up to 100 if heavily tinted/unclear.',
                  'visible_confidence = overall confidence 0–100 that visible traits were read correctly.',
                  'natural_summary must be 10–14 short factual sentences, following the guidelines above.',
                  'Produce only the JSON document. Nothing else.'
                ].join('\n')
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
        max_tokens: 900,
        temperature: 0.1
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
    const contentString = typeof rawContent === 'string' ? rawContent.trim() : '';
    if (!contentString) {
      console.warn('Single selection description response was empty.');
      return null;
    }

    let parsed;
    try {
      parsed = JSON.parse(contentString);
    } catch (parseError) {
      console.error('Failed to parse single selection description JSON:', {
        message: parseError?.message,
        contentPreview: contentString.slice(0, 400)
      });
      return null;
    }

    const schema = parsed && typeof parsed === 'object' ? parsed.description_schema : null;
    if (!schema || typeof schema !== 'object') {
      console.warn('Single selection description schema missing or invalid.');
      return null;
    }

    const naturalSummary = typeof schema.natural_summary === 'string'
      ? schema.natural_summary.trim()
      : '';

    if (!naturalSummary) {
      console.warn('Single selection natural_summary missing in schema.');
      return null;
    }

    // Basic sanity: ensure a few critical keys exist so we do not store half-baked schemas.
    const requiredKeys = [
      'visible_area',
      'gender_presentation',
      'age_band',
      'build',
      'height_impression',
      'skin_tone',
      'hair',
      'clothing',
      'distinctiveness_score',
      'lighting_uncertainty',
      'visible_confidence'
    ];
    const hasAllRequired = requiredKeys.every((key) => Object.prototype.hasOwnProperty.call(schema, key));
    if (!hasAllRequired) {
      console.warn('Single selection description schema missing required keys.');
      return null;
    }

    return {
      schema,
      naturalSummary
    };
  } catch (error) {
    console.error('Error while generating single selection description:', {
      message: error?.message,
      stack: error?.stack
    });
    return null;
  }
}

// Deterministic grouping based on structured description schema.
async function evaluateDescriptionGrouping(newDescriptionSchema, existingGroups) {
  const MERGE_THRESHOLD = GROUPING_MATCH_THRESHOLD || 60;

  const scoredGroups = scoreDescriptionAgainstGroups(newDescriptionSchema, existingGroups);
  if (!scoredGroups.length) {
    return {
      bestGroupId: null,
      bestGroupProbability: 0,
      explanation: ''
    };
  }

  const top = scoredGroups[0];

  if (!top || top.score < MERGE_THRESHOLD) {
    return {
      bestGroupId: null,
      bestGroupProbability: top ? top.score : 0,
      explanation: top ? top.explanation : ''
    };
  }

  const tied = scoredGroups.filter((g) => (top.score - g.score) <= TIE_DELTA);
  let best = top;
  if (tied.length > 1) {
    tied.sort((a, b) => {
      if (b.distinctiveBonus !== a.distinctiveBonus) {
        return b.distinctiveBonus - a.distinctiveBonus;
      }
      if (b.memberCount !== a.memberCount) {
        return b.memberCount - a.memberCount;
      }
      return 0;
    });
    best = tied[0];
  }

  return {
    bestGroupId: best.groupId ?? null,
    bestGroupProbability: best.score,
    explanation: best.explanation || ''
  };
}

module.exports = {
  generateStablePersonDescription,
  evaluateDescriptionGrouping,
  GROUPING_MATCH_THRESHOLD
};

