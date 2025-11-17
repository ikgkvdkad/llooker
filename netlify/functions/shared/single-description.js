const OPENAI_MODEL = 'gpt-4o-mini';
// Threshold for attaching a selection to an existing person group.
// Aligned with the deterministic MERGE_THRESHOLD in evaluateDescriptionGrouping.
const GROUPING_MATCH_THRESHOLD = 60;

// Shared scoring constants for deterministic grouping and neighbor scoring.
// NOTE: These are *not* normalized; pro and contra scores are allowed to grow.
const LOCATION_MATCH_BONUS = 8;
const RARE_MISSING_PENALTY = -6;
const TIE_DELTA = 6;

// Pro/contra thresholds
const PRO_MIN = 120;      // minimum proScore to consider a group
const CONTRA_MAX = 40;    // maximum contraScore tolerated

// Clothing weights (stable items dominate)
const STABLE_CLOTHING_PRO_WEIGHTS = {
  top: 40,
  jacket: 35,
  trousers: 40,
  shoes: 35,
  dress: 40
};

const STABLE_CLOTHING_CONTRA_WEIGHTS = {
  top: 30,
  jacket: 30,
  trousers: 30,
  shoes: 25,
  dress: 30
};

// Rare/distinctive
const RARE_PRO_BASE = 80;
const RARE_CONTRA_BASE = 40;

// Physical traits
const PHYSICAL_PRO_WEIGHTS = {
  gender_presentation: 25,
  age_band: 20,
  build: 15,
  height_impression: 10,
  skin_tone: 15
};

const PHYSICAL_CONTRA_WEIGHTS = {
  gender_presentation: 120,  // near-fatal when high-confidence conflict
  age_band: 25,
  build: 15,
  height_impression: 15,
  skin_tone: 20
};

// Hair and facial hair
const HAIR_PRO_WEIGHTS = {
  color: 15,
  length: 8,
  style: 5,
  facial_hair: 8
};

const HAIR_CONTRA_WEIGHTS = {
  color: 15,
  length: 10,
  facial_hair: 20
};

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

/**
 * Compute separate pro and contra scores between a new description and a canonical group description.
 * Returns unbounded pro/contra scores plus a rough domain breakdown.
 */
function computeProContraScores(newSchema, groupCanonical) {
  if (!newSchema || typeof newSchema !== 'object' || !groupCanonical || typeof groupCanonical !== 'object') {
    return {
      proScore: 0,
      contraScore: 0,
      breakdown: {
        clothingPro: 0,
        clothingContra: 0,
        rarePro: 0,
        rareContra: 0,
        physicalPro: 0,
        physicalContra: 0,
        hairPro: 0,
        hairContra: 0
      },
      fatalGenderMismatch: false
    };
  }

  const breakdown = {
    clothingPro: 0,
    clothingContra: 0,
    rarePro: 0,
    rareContra: 0,
    physicalPro: 0,
    physicalContra: 0,
    hairPro: 0,
    hairContra: 0
  };

  let proScore = 0;
  let contraScore = 0;
  let fatalGenderMismatch = false;

  const visibleConfidence = Number(newSchema.visible_confidence) || 0;
  const visibilityFactor = Math.max(0.3, Math.min(1, visibleConfidence / 100));

  const newClothing = newSchema.clothing && typeof newSchema.clothing === 'object'
    ? newSchema.clothing
    : {};
  const groupClothing = groupCanonical.clothing && typeof groupCanonical.clothing === 'object'
    ? groupCanonical.clothing
    : {};

  const lightingUncertainty = Number(newSchema.lighting_uncertainty) || 0;

  // Clothing pros/cons.
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

    const econf = effectiveConfidence(newSlot.confidence, groupSlot.confidence) * visibilityFactor;
    if (econf <= 0) continue;

    const isStableNew = newSlot.permanence === 'stable';
    const isStableGroup = groupSlot.permanence === 'stable';

    const colorOk = areColorsEquivalent(newSlot.color, groupSlot.color, lightingUncertainty);
    const descOk = substringTokenMatch(newSlot.description, groupSlot.description);
    const colorScore = colorOk ? 1 : 0;
    const descScore = descOk ? 1 : 0;
    const slotSim = (colorScore * 0.6) + (descScore * 0.4);

    let stabilityMultiplier = 1;
    if (newSlot.permanence === 'removable' || groupSlot.permanence === 'removable') {
      stabilityMultiplier = 0.3;
    } else if (newSlot.permanence === 'possibly_removable' || groupSlot.permanence === 'possibly_removable') {
      stabilityMultiplier = 0.6;
    }

    const basePro = STABLE_CLOTHING_PRO_WEIGHTS[slot] || 0;
    const baseContra = STABLE_CLOTHING_CONTRA_WEIGHTS[slot] || 0;

    if (slotSim > 0 && basePro > 0) {
      const contrib = basePro * slotSim * stabilityMultiplier * econf;
      proScore += contrib;
      breakdown.clothingPro += contrib;
    }

    // Strong contradictions on stable clothing only.
    if (isStableNew && isStableGroup && slotSim <= 0.2 && baseContra > 0) {
      const contraContrib = baseContra * (1 - slotSim) * econf;
      contraScore += contraContrib;
      breakdown.clothingContra += contraContrib;
    }
  }

  // Rare / distinctive marks and rare clothing.
  const newMarks = Array.isArray(newSchema.distinctive_marks) ? newSchema.distinctive_marks : [];
  const groupMarks = Array.isArray(groupCanonical.distinctive_marks) ? groupCanonical.distinctive_marks : [];

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
      const econf = effectiveConfidence(matched.confidence, gmConf) * visibilityFactor;
      if (econf > 0) {
        let contrib = RARE_PRO_BASE * (rarity / 100) * econf;
        const nmLocation = matched.location || null;
        if ((gmLocation && nmLocation && gmLocation === nmLocation) || (!gmLocation && !nmLocation)) {
          contrib += LOCATION_MATCH_BONUS * econf;
        }
        proScore += contrib;
        breakdown.rarePro += contrib;
      }
    } else {
      const missingRare = newMarks.some((nm) => {
        if (!nm || typeof nm !== 'object') return false;
        if (gmType && nm.type && gmType !== nm.type) return false;
        return nm.description === 'unknown' && Number(nm.confidence) >= 80;
      });
      if (missingRare) {
        const contraContrib = RARE_CONTRA_BASE * (rarity / 100) * visibilityFactor;
        contraScore += contraContrib;
        breakdown.rareContra += contraContrib;
      }
    }
  }

  // Physical traits.
  const physFields = ['gender_presentation', 'age_band', 'build', 'height_impression', 'skin_tone'];
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

    const econf = effectiveConfidence(newField.confidence, groupField.confidence) * visibilityFactor;
    if (econf <= 0) continue;

    const wPro = PHYSICAL_PRO_WEIGHTS[field] || 0;
    const wContra = PHYSICAL_CONTRA_WEIGHTS[field] || 0;

    if (nv === gv) {
      if (wPro > 0) {
        const contrib = wPro * econf;
        proScore += contrib;
        breakdown.physicalPro += contrib;
      }
    } else if (field === 'age_band' && ageAdjacent(nv, gv)) {
      // Slight disagreement in age bands – small contra, small pro forgiveness.
      if (wPro > 0) {
        const contrib = (wPro * 0.4) * econf;
        proScore += contrib;
        breakdown.physicalPro += contrib;
      }
      if (wContra > 0) {
        const contraContrib = (wContra * 0.2) * econf;
        contraScore += contraContrib;
        breakdown.physicalContra += contraContrib;
      }
    } else {
      if (field === 'gender_presentation') {
        // Gender mismatch is near-fatal.
        const fatalContra = (PHYSICAL_CONTRA_WEIGHTS.gender_presentation || 120) * econf;
        contraScore += fatalContra;
        breakdown.physicalContra += fatalContra;
        fatalGenderMismatch = true;
      } else if (wContra > 0) {
        const contraContrib = wContra * econf;
        contraScore += contraContrib;
        breakdown.physicalContra += contraContrib;
      }
    }
  }

  // Hair and facial hair.
  const hairNew = newSchema.hair && typeof newSchema.hair === 'object' ? newSchema.hair : null;
  const hairGroup = groupCanonical.hair && typeof groupCanonical.hair === 'object' ? groupCanonical.hair : null;
  if (hairNew && hairGroup) {
    const newColor = hairNew.color || {};
    const groupColor = hairGroup.color || {};
    if (newColor.value && groupColor.value && newColor.value !== 'unknown' && groupColor.value !== 'unknown') {
      const econf = effectiveConfidence(newColor.confidence, groupColor.confidence) * visibilityFactor;
      if (econf > 0) {
        if (areColorsEquivalent(newColor.value, groupColor.value, lightingUncertainty)) {
          const contrib = HAIR_PRO_WEIGHTS.color * econf;
          proScore += contrib;
          breakdown.hairPro += contrib;
        } else {
          const contraContrib = HAIR_CONTRA_WEIGHTS.color * econf;
          contraScore += contraContrib;
          breakdown.hairContra += contraContrib;
        }
      }
    }

    const newLength = hairNew.length || {};
    const groupLength = hairGroup.length || {};
    if (newLength.value && groupLength.value && newLength.value !== 'unknown' && groupLength.value !== 'unknown') {
      const econf = effectiveConfidence(newLength.confidence, groupLength.confidence) * visibilityFactor;
      if (econf > 0) {
        if (newLength.value === groupLength.value) {
          const contrib = HAIR_PRO_WEIGHTS.length * econf;
          proScore += contrib;
          breakdown.hairPro += contrib;
        } else {
          const contraContrib = HAIR_CONTRA_WEIGHTS.length * econf;
          contraScore += contraContrib;
          breakdown.hairContra += contraContrib;
        }
      }
    }

    const newStyle = hairNew.style || {};
    const groupStyle = hairGroup.style || {};
    if (newStyle.value && groupStyle.value && newStyle.value !== 'unknown' && groupStyle.value !== 'unknown') {
      const econf = effectiveConfidence(newStyle.confidence, groupStyle.confidence) * visibilityFactor;
      if (econf > 0 && substringTokenMatch(newStyle.value, groupStyle.value)) {
        const contrib = HAIR_PRO_WEIGHTS.style * econf;
        proScore += contrib;
        breakdown.hairPro += contrib;
      }
    }

    const newFacial = hairNew.facial_hair || {};
    const groupFacial = hairGroup.facial_hair || {};
    if (newFacial.value && groupFacial.value && newFacial.value !== 'unknown' && groupFacial.value !== 'unknown') {
      const econf = effectiveConfidence(newFacial.confidence, groupFacial.confidence) * visibilityFactor;
      if (econf > 0) {
        if (newFacial.value === groupFacial.value) {
          const contrib = HAIR_PRO_WEIGHTS.facial_hair * econf;
          proScore += contrib;
          breakdown.hairPro += contrib;
        } else {
          const contraContrib = HAIR_CONTRA_WEIGHTS.facial_hair * econf;
          contraScore += contraContrib;
          breakdown.hairContra += contraContrib;
        }
      }
    }
  }

  return {
    proScore,
    contraScore,
    breakdown,
    fatalGenderMismatch
  };
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
  if (!newDescriptionSchema || typeof newDescriptionSchema !== 'object' || !Array.isArray(existingGroups) || !existingGroups.length) {
    return {
      bestGroupId: null,
      bestGroupProbability: 0,
      explanation: ''
    };
  }

  const scored = [];
  for (const group of existingGroups) {
    if (!group || typeof group !== 'object') continue;
    const canonical = group.group_canonical;
    if (!canonical || typeof canonical !== 'object') continue;
    const groupId = group.group_id;
    const memberCount = Number(group.group_member_count) || 0;

    const { proScore, contraScore, breakdown, fatalGenderMismatch } =
      computeProContraScores(newDescriptionSchema, canonical);

    scored.push({
      groupId,
      memberCount,
      proScore,
      contraScore,
      breakdown,
      fatalGenderMismatch
    });
  }

  if (!scored.length) {
    return {
      bestGroupId: null,
      bestGroupProbability: 0,
      explanation: ''
    };
  }

  // Apply pro/contra gates.
  const survivors = scored.filter((g) => g.proScore >= PRO_MIN && g.contraScore <= CONTRA_MAX);

  if (!survivors.length) {
    // Find the best overall candidate for explanation purposes.
    scored.sort((a, b) => b.proScore - a.proScore);
    const candidate = scored[0];
    const explanation = candidate
      ? `No group passed thresholds. Best candidate had proScore=${Math.round(candidate.proScore)}, contraScore=${Math.round(candidate.contraScore)}.`
      : '';

    return {
      bestGroupId: null,
      bestGroupProbability: 0,
      explanation
    };
  }

  survivors.sort((a, b) => b.proScore - a.proScore);
  const top = survivors[0];
  const tied = survivors.filter((g) => Math.abs(top.proScore - g.proScore) <= TIE_DELTA);

  let best = top;
  if (tied.length > 1) {
    tied.sort((a, b) => {
      // Prefer groups with lower contraScore, then higher memberCount.
      if (a.contraScore !== b.contraScore) {
        return a.contraScore - b.contraScore;
      }
      if (b.memberCount !== a.memberCount) {
        return b.memberCount - a.memberCount;
      }
      return 0;
    });
    best = tied[0];
  }

  const pro = Math.round(best.proScore);
  const contra = Math.round(best.contraScore);

  // Derive a friendly 0–100 "likelihood" purely for UI.
  const denominator = best.proScore + best.contraScore + 50;
  const probability = denominator > 0
    ? Math.max(0, Math.min(100, Math.round((best.proScore / denominator) * 100)))
    : 0;

  const bd = best.breakdown || {};
  const clothingPro = Math.round(bd.clothingPro || 0);
  const physicalPro = Math.round(bd.physicalPro || 0);
  const hairPro = Math.round(bd.hairPro || 0);
  const rarePro = Math.round(bd.rarePro || 0);

  const clothingContra = Math.round(bd.clothingContra || 0);
  const physicalContra = Math.round(bd.physicalContra || 0);
  const hairContra = Math.round(bd.hairContra || 0);
  const rareContra = Math.round(bd.rareContra || 0);

  const proParts = [];
  if (clothingPro > 0) proParts.push(`clothing ${clothingPro}`);
  if (physicalPro > 0) proParts.push(`physical ${physicalPro}`);
  if (hairPro > 0) proParts.push(`hair ${hairPro}`);
  if (rarePro > 0) proParts.push(`rare ${rarePro}`);

  const contraParts = [];
  if (clothingContra > 0) contraParts.push(`clothing ${clothingContra}`);
  if (physicalContra > 0) contraParts.push(`physical ${physicalContra}`);
  if (hairContra > 0) contraParts.push(`hair ${hairContra}`);
  if (rareContra > 0) contraParts.push(`rare ${rareContra}`);

  const proText = proParts.length ? proParts.join(', ') : 'none';
  const contraText = contraParts.length ? contraParts.join(', ') : 'none';

  const explanation = `proScore=${pro}, contraScore=${contra}. Pros: ${proText}. Contras: ${contraText}.`;

  return {
    bestGroupId: best.groupId ?? null,
    bestGroupProbability: probability,
    explanation
  };
}

module.exports = {
  generateStablePersonDescription,
  evaluateDescriptionGrouping,
  GROUPING_MATCH_THRESHOLD
};

