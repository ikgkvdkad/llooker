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

const FATAL_GATE_ENABLED = (process.env.SINGLE_FATAL_GATE ?? 'on') !== 'off';
const FATAL_CONFIDENCE_PRODUCT_THRESHOLD = (() => {
  const raw = Number(process.env.SINGLE_FATAL_CONFIDENCE_PRODUCT_THRESHOLD);
  if (Number.isFinite(raw)) {
    return Math.max(0, Math.min(1, raw));
  }
  return 0.49; // ~= 0.7 * 0.7
})();
const FATAL_MARK_MIN_CONFIDENCE = (() => {
  const raw = Number(process.env.SINGLE_FATAL_MARK_MIN_CONFIDENCE);
  if (Number.isFinite(raw)) {
    return Math.max(0, Math.min(100, raw));
  }
  return 70;
})();
const CLOTHING_PRO_CAP_RATIO = (() => {
  const raw = Number(process.env.CLOTHING_PRO_CAP_RATIO);
  if (Number.isFinite(raw) && raw > 0) {
    return raw;
  }
  return 1.0; // allow full PRO_MIN contribution from strong clothing matches
})();
const CLOTHING_PRO_CAP = (() => {
  const raw = Number(process.env.CLOTHING_PRO_CAP);
  if (Number.isFinite(raw) && raw >= 0) {
    return raw;
  }
  return Math.round(PRO_MIN * CLOTHING_PRO_CAP_RATIO);
})();
const PRO_SOFT_MAX = (() => {
  const raw = Number(process.env.PRO_SOFT_MAX);
  if (Number.isFinite(raw) && raw > 0) {
    return raw;
  }
  return 180; // softer normalization so ~270 raw pro passes 60 norm gate
})();
const CONTRA_SOFT_MAX = (() => {
  const raw = Number(process.env.CONTRA_SOFT_MAX);
  if (Number.isFinite(raw) && raw > 0) {
    return raw;
  }
  return 120;
})();
const NORMALIZED_SCORE_SCALE = 100;
const NORM_PRO_MIN = (() => {
  const raw = Number(process.env.NORM_PRO_MIN);
  if (Number.isFinite(raw)) {
    return Math.max(0, Math.min(100, raw));
  }
  return 35; // real-world same-person photos score 35-45 normalized
})();
const NORM_CONTRA_MAX = (() => {
  const raw = Number(process.env.NORM_CONTRA_MAX);
  if (Number.isFinite(raw)) {
    return Math.max(0, Math.min(100, raw));
  }
  return 40;
})();
const TEXT_SHORTLIST_LIMIT = (() => {
  const raw = Number(process.env.TEXT_SHORTLIST_LIMIT);
  if (Number.isFinite(raw) && raw > 0) {
    return Math.floor(raw);
  }
  return 3;
})();

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

const CLOTHING_SLOTS = ['top', 'jacket', 'trousers', 'shoes', 'dress'];
const COLOR_MATCH_WEIGHT = 0.6;
const TYPE_MATCH_WEIGHT = 0.4;
const CONTRA_MISMATCH_THRESHOLD = 0.2;
const OUTER_LAYER_KEYWORDS = ['blazer', 'jacket', 'coat', 'cardigan', 'sport coat', 'suit jacket'];
const CROSS_SLOT_OUTER_LAYER_BONUS = 10;

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

const LOWER_GARMENT_KEYWORDS = {
  full_length: ['pant', 'pants', 'jean', 'jeans', 'slack', 'trouser', 'trousers', 'chino', 'chinos', 'jogger', 'joggers', 'cargo'],
  skirt: ['skirt'],
  shorts: ['short', 'shorts', 'bermuda'],
  one_piece: ['dress', 'gown', 'romper', 'jumper', 'onesie']
};

const ABSENCE_KEYWORDS = ['no ', 'none', 'without', 'absent'];

const FATAL_MISMATCH_TYPES = {
  LOWER_GARMENT: 'lower_garment',
  HAIR_COLOR: 'hair_color',
  GENDER: 'gender',
  AGE: 'age',
  MARK: 'mark'
};
const MIN_CLARITY_FOR_FATAL_HAIR = 60;
const CLARITY_OVERRIDE_DELTA = 5;
const CLARITY_OVERRIDE_PRO_MIN = PRO_MIN - 5; // allow slightly under raw threshold
const CLARITY_OVERRIDE_CONTRA_MAX = CONTRA_MAX + 5;

function buildCandidateDetails(candidate, newClarity, probabilityOverride) {
  if (!candidate || typeof candidate !== 'object') {
    return null;
  }
  const bd = candidate.breakdown || {};
  const pro = Math.round(candidate.proScore || 0);
  const contra = Math.round(candidate.contraScore || 0);
  const normPro = toOneDecimal(candidate.normPro || 0);
  const normContra = toOneDecimal(candidate.normContra || 0);
  const probability = Number.isFinite(Number(probabilityOverride))
    ? Math.round(Number(probabilityOverride))
    : Number.isFinite(Number(candidate.probability))
      ? Math.round(Number(candidate.probability))
      : computeNormalizedProbability(normPro, normContra);

  let clothingCapNote = '';
  if (
    typeof bd.clothingProRaw === 'number' &&
    typeof bd.clothingProApplied === 'number' &&
    bd.clothingProRaw > bd.clothingProApplied
  ) {
    clothingCapNote = `capped at ${Math.round(bd.clothingProApplied)} of ${Math.round(bd.clothingProRaw)}`;
  }

  const makeContribution = (value, category, note) => ({
    category,
    value: Math.round(value || 0),
    note: note || null
  });

  const proContributions = [];
  if (bd.clothingPro > 0) proContributions.push(makeContribution(bd.clothingPro, 'clothing', clothingCapNote || null));
  if (bd.physicalPro > 0) proContributions.push(makeContribution(bd.physicalPro, 'physical'));
  if (bd.hairPro > 0) proContributions.push(makeContribution(bd.hairPro, 'hair'));
  if (bd.rarePro > 0) proContributions.push(makeContribution(bd.rarePro, 'rare'));

  const contraContributions = [];
  if (bd.clothingContra > 0) contraContributions.push(makeContribution(bd.clothingContra, 'clothing'));
  if (bd.physicalContra > 0) contraContributions.push(makeContribution(bd.physicalContra, 'physical'));
  if (bd.hairContra > 0) contraContributions.push(makeContribution(bd.hairContra, 'hair'));
  if (bd.rareContra > 0) contraContributions.push(makeContribution(bd.rareContra, 'rare'));

  return {
    rawScores: { pro, contra },
    normalized: {
      normPro,
      normContra,
      probability,
      requiredNormPro: NORM_PRO_MIN,
      requiredNormContra: NORM_CONTRA_MAX
    },
    proContributions,
    contraContributions,
    clarity: {
      newImage: Number.isFinite(newClarity) ? Number(newClarity) : null,
      canonical: typeof candidate.groupClarity === 'number' ? candidate.groupClarity : null
    },
    fallbackApplied: false,
    fallbackReason: null
  };
}

function confidenceProduct(valueA, valueB) {
  const a = Number(valueA);
  const b = Number(valueB);
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    return 0;
  }
  return Math.max(0, Math.min(1, (a / 100) * (b / 100)));
}

function effectiveConfidence(newConfidence, groupConfidence) {
  return confidenceProduct(newConfidence, groupConfidence);
}

function normalizeScore(value, cap, scale = NORMALIZED_SCORE_SCALE) {
  const safeValue = Math.max(0, Number(value) || 0);
  const safeCap = Math.max(1, Number(cap) || 1);
  const ratio = safeValue / (safeValue + safeCap);
  return Math.max(0, Math.min(scale, ratio * scale));
}

function computeNormalizedProbability(normPro, normContra) {
  const pro = Math.max(0, Math.min(100, Number(normPro) || 0));
  const contra = Math.max(0, Math.min(100, Number(normContra) || 0));
  const probability = pro * (1 - contra / 100);
  return Math.max(0, Math.min(100, Math.round(probability)));
}

function toOneDecimal(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.round(num * 10) / 10;
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

function createEmptyBreakdown() {
  return {
    clothingPro: 0,
    clothingProApplied: 0,
    clothingProCap: CLOTHING_PRO_CAP,
    clothingProRaw: 0,
    clothingContra: 0,
    rarePro: 0,
    rareContra: 0,
    physicalPro: 0,
    physicalContra: 0,
    hairPro: 0,
    hairContra: 0
  };
}

function normalizeText(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim().toLowerCase();
}

function sanitizeClarity(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return null;
  }
  const clamped = Math.max(0, Math.min(100, Math.round(num)));
  return clamped;
}

function computeSchemaClarity(schema) {
  if (!schema || typeof schema !== 'object') {
    return 0;
  }
  const base = Number(schema.image_clarity);
  const normalizedBase = Number.isFinite(base) ? Math.max(0, Math.min(100, base)) : 0;
  const normalizedEvents = [];

  const evalField = (obj, key, weight = 5) => {
    if (!obj || typeof obj !== 'object') return 0;
    const value = obj.value;
    const confidence = Number(obj.confidence);
    if (typeof value !== 'string' || !value || value === 'unknown') return 0;
    if (!Number.isFinite(confidence) || confidence < 50) return 0;
    return Math.min(weight, (confidence / 100) * weight);
  };

  const hairScore =
    evalField(schema.hair?.color, 'value', 10) +
    evalField(schema.hair?.length, 'value', 4) +
    evalField(schema.hair?.facial_hair, 'value', 4);

  const physicalScore =
    evalField(schema.gender_presentation, 'value', 6) +
    evalField(schema.age_band, 'value', 6) +
    evalField(schema.build, 'value', 4) +
    evalField(schema.skin_tone, 'value', 4) +
    evalField(schema.height_impression, 'value', 2);

  const clothingScore = ['top', 'trousers', 'shoes', 'jacket', 'dress'].reduce((sum, slot) => {
    const part = schema.clothing?.[slot];
    if (!part || typeof part !== 'object') return sum;
    const color = part.color;
    const desc = part.description;
    const colorScore = evalField({ value: typeof color === 'string' ? color : '', confidence: part.confidence }, 'value', 8);
    const descScore = typeof desc === 'string' && desc ? Math.min(5, (Number(part.confidence) || 0) / 100 * 5) : 0;
    return sum + colorScore + descScore;
  }, 0);

  const accessoryScore = Array.isArray(schema.accessories)
    ? Math.min(10, schema.accessories.reduce((sum, item) => {
        if (!item || typeof item !== 'object') return sum;
        const conf = Number(item.confidence);
        if (!Number.isFinite(conf) || conf < 50) return sum;
        return sum + 2;
      }, 0))
    : 0;

  const distinctivenessScore = Number(schema.distinctiveness_score);
  const distinctScore = Number.isFinite(distinctivenessScore)
    ? Math.min(10, distinctivenessScore / 10)
    : 0;

  const coverageBonus = (() => {
    const fields = [
      schema.hair?.color?.value,
      schema.hair?.length?.value,
      schema.gender_presentation?.value,
      schema.age_band?.value,
      schema.build?.value,
      schema.skin_tone?.value,
      schema.clothing?.top?.description,
      schema.clothing?.trousers?.description,
      schema.clothing?.shoes?.description
    ];
    const filled = fields.filter((v) => typeof v === 'string' && v && v !== 'unknown').length;
    return Math.min(15, filled * 2);
  })();

  const composite = normalizedBase + hairScore + physicalScore + clothingScore + accessoryScore + distinctScore + coverageBonus;
  return Math.max(0, Math.min(100, Math.round(composite)));
}

function includesKeyword(text, keywords) {
  if (!text || !keywords || !keywords.length) {
    return false;
  }
  return keywords.some((kw) => text.includes(kw));
}

function describeLowerGarmentFamily(family) {
  if (family === 'full_length') return 'full-length pants/jeans';
  if (family === 'skirt') return 'skirt';
  if (family === 'shorts') return 'shorts';
  if (family === 'one_piece') return 'dress/one-piece';
  return family || 'unknown';
}

function classifyLowerGarment(schema) {
  if (!schema || typeof schema !== 'object') {
    return null;
  }
  const clothing = schema.clothing && typeof schema.clothing === 'object' ? schema.clothing : {};
  const dress = clothing.dress;
  if (isUsableClothingItem(dress)) {
    const desc = normalizeText(dress.description);
    if (desc && desc !== 'unknown') {
      return {
        family: 'one_piece',
        label: describeLowerGarmentFamily('one_piece'),
        confidence: Number(dress.confidence) || 0
      };
    }
  }
  const trousers = clothing.trousers;
  if (!isUsableClothingItem(trousers)) {
    return null;
  }
  const desc = normalizeText(trousers.description);
  if (!desc || desc === 'unknown') {
    return null;
  }
  const confidence = Number(trousers.confidence) || 0;
  for (const [family, keywords] of Object.entries(LOWER_GARMENT_KEYWORDS)) {
    if (includesKeyword(desc, keywords)) {
      return {
        family,
        label: describeLowerGarmentFamily(family),
        confidence
      };
    }
  }
  return null;
}

function areLowerFamiliesContradictory(a, b) {
  if (!a || !b || a === b) {
    return false;
  }
  const pantsFamilies = new Set(['full_length']);
  const nonPantsFamilies = new Set(['skirt', 'shorts', 'one_piece']);
  return (
    (pantsFamilies.has(a) && nonPantsFamilies.has(b)) ||
    (pantsFamilies.has(b) && nonPantsFamilies.has(a))
  );
}

function hasAbsenceKeyword(text) {
  if (!text) return false;
  return ABSENCE_KEYWORDS.some((kw) => text.includes(kw));
}

function summarizeDistinctiveMarkState(schema) {
  const marks = Array.isArray(schema?.distinctive_marks) ? schema.distinctive_marks : [];
  const summary = {
    tattooPresent: 0,
    tattooAbsent: 0,
    scarPresent: 0,
    scarAbsent: 0
  };
  for (const mark of marks) {
    if (!mark || typeof mark !== 'object') continue;
    const conf = Number(mark.confidence);
    if (!Number.isFinite(conf) || conf < FATAL_MARK_MIN_CONFIDENCE) continue;
    const type = normalizeText(mark.type);
    const desc = normalizeText(mark.description);
    if (!type || !desc || desc === 'unknown') continue;
    const indicatesAbsence = hasAbsenceKeyword(desc);
    if (type === 'tattoo') {
      if (indicatesAbsence) {
        summary.tattooAbsent = Math.max(summary.tattooAbsent, conf);
      } else {
        summary.tattooPresent = Math.max(summary.tattooPresent, conf);
      }
    } else if (type === 'scar') {
      if (indicatesAbsence) {
        summary.scarAbsent = Math.max(summary.scarAbsent, conf);
      } else {
        summary.scarPresent = Math.max(summary.scarPresent, conf);
      }
    }
  }
  return summary;
}

function buildFatalResult(type, detail, confidencePair) {
  return {
    type,
    detail,
    confidencePair: Number.isFinite(confidencePair)
      ? Number(confidencePair.toFixed(2))
      : null
  };
}

function detectDistinctiveMarkFatal(newSchema, canonical) {
  const newMarks = summarizeDistinctiveMarkState(newSchema);
  const groupMarks = summarizeDistinctiveMarkState(canonical);
  const checks = [
    {
      label: 'tattoo',
      newPresence: newMarks.tattooPresent,
      newAbsence: newMarks.tattooAbsent,
      groupPresence: groupMarks.tattooPresent,
      groupAbsence: groupMarks.tattooAbsent
    },
    {
      label: 'scar',
      newPresence: newMarks.scarPresent,
      newAbsence: newMarks.scarAbsent,
      groupPresence: groupMarks.scarPresent,
      groupAbsence: groupMarks.scarAbsent
    }
  ];

  for (const entry of checks) {
    const pairPresenceVsAbsence = confidenceProduct(entry.newPresence, entry.groupAbsence);
    if (pairPresenceVsAbsence >= FATAL_CONFIDENCE_PRODUCT_THRESHOLD) {
      return buildFatalResult(
        FATAL_MISMATCH_TYPES.MARK,
        `${entry.label} present vs explicitly absent`,
        pairPresenceVsAbsence
      );
    }
    const pairAbsenceVsPresence = confidenceProduct(entry.groupPresence, entry.newAbsence);
    if (pairAbsenceVsPresence >= FATAL_CONFIDENCE_PRODUCT_THRESHOLD) {
      return buildFatalResult(
        FATAL_MISMATCH_TYPES.MARK,
        `${entry.label} present vs explicitly absent`,
        pairAbsenceVsPresence
      );
    }
  }

  return null;
}

function detectFatalMismatch(newSchema, canonical) {
  if (!FATAL_GATE_ENABLED) {
    return null;
  }
  if (!newSchema || typeof newSchema !== 'object' || !canonical || typeof canonical !== 'object') {
    return null;
  }

  const lowerNew = classifyLowerGarment(newSchema);
  const lowerGroup = classifyLowerGarment(canonical);
  if (lowerNew && lowerGroup && areLowerFamiliesContradictory(lowerNew.family, lowerGroup.family)) {
    const pairConf = confidenceProduct(lowerNew.confidence, lowerGroup.confidence);
    if (pairConf >= FATAL_CONFIDENCE_PRODUCT_THRESHOLD) {
      return buildFatalResult(
        FATAL_MISMATCH_TYPES.LOWER_GARMENT,
        `${lowerNew.label} vs ${lowerGroup.label}`,
        pairConf
      );
    }
  }

  const hairNew = newSchema?.hair?.color;
  const hairGroup = canonical?.hair?.color;
  const newClarity = computeSchemaClarity(newSchema);
  const groupClarity = computeSchemaClarity(canonical);
  if (
    hairNew?.value &&
    hairGroup?.value &&
    hairNew.value !== 'unknown' &&
    hairGroup.value !== 'unknown' &&
    groupClarity >= MIN_CLARITY_FOR_FATAL_HAIR &&
    newClarity >= MIN_CLARITY_FOR_FATAL_HAIR
  ) {
    const pairConf = confidenceProduct(hairNew.confidence, hairGroup.confidence);
    if (pairConf >= FATAL_CONFIDENCE_PRODUCT_THRESHOLD) {
      const lightingUncertainty = Number(newSchema?.lighting_uncertainty) || 0;
      if (!areColorsEquivalent(hairNew.value, hairGroup.value, lightingUncertainty)) {
        return buildFatalResult(
          FATAL_MISMATCH_TYPES.HAIR_COLOR,
          `${hairNew.value} vs ${hairGroup.value}`,
          pairConf
        );
      }
    }
  }

  const genderNew = newSchema?.gender_presentation;
  const genderGroup = canonical?.gender_presentation;
  if (
    genderNew?.value &&
    genderGroup?.value &&
    genderNew.value !== 'unknown' &&
    genderGroup.value !== 'unknown' &&
    genderNew.value !== genderGroup.value
  ) {
    const pairConf = confidenceProduct(genderNew.confidence, genderGroup.confidence);
    if (pairConf >= FATAL_CONFIDENCE_PRODUCT_THRESHOLD) {
      return buildFatalResult(
        FATAL_MISMATCH_TYPES.GENDER,
        `${genderNew.value} vs ${genderGroup.value}`,
        pairConf
      );
    }
  }

  const ageNew = newSchema?.age_band;
  const ageGroup = canonical?.age_band;
  if (
    ageNew?.value &&
    ageGroup?.value &&
    ageNew.value !== 'unknown' &&
    ageGroup.value !== 'unknown'
  ) {
    const pairConf = confidenceProduct(ageNew.confidence, ageGroup.confidence);
    if (pairConf >= FATAL_CONFIDENCE_PRODUCT_THRESHOLD) {
      const compatible = ageNew.value === ageGroup.value || ageAdjacent(ageNew.value, ageGroup.value);
      if (!compatible) {
        return buildFatalResult(
          FATAL_MISMATCH_TYPES.AGE,
          `${ageNew.value} vs ${ageGroup.value}`,
          pairConf
        );
      }
    }
  }

  const markFatal = detectDistinctiveMarkFatal(newSchema, canonical);
  if (markFatal) {
    return markFatal;
  }

  return null;
}

function formatFatalMismatchMessage(fatal) {
  if (!fatal) {
    return '';
  }
  const confText = Number.isFinite(fatal.confidencePair)
    ? ` (conf_pair=${fatal.confidencePair.toFixed(2)})`
    : '';
  return `Fatal mismatch: ${fatal.detail}${confText}.`;
}

function ageAdjacent(a, b) {
  const order = ['18-24', '25-34', '35-44', '45-54', '55+'];
  const ia = order.indexOf(a);
  const ib = order.indexOf(b);
  if (ia === -1 || ib === -1) return false;
  return Math.abs(ia - ib) === 1;
}

function isUsableClothingItem(item) {
  return !!(item && typeof item === 'object' && item.description && item.description !== 'unknown');
}

function getGarmentCategory(slotName, description) {
  const desc = (description || '').toLowerCase();
  if (slotName === 'trousers') return 'lower';
  if (slotName === 'shoes') return 'footwear';
  if (slotName === 'dress') return 'one_piece';
  if (slotName === 'jacket') return 'outer_layer';
  if (slotName === 'top') {
    if (OUTER_LAYER_KEYWORDS.some((kw) => desc.includes(kw))) {
      return 'outer_layer';
    }
    return 'base_top';
  }
  if (OUTER_LAYER_KEYWORDS.some((kw) => desc.includes(kw))) {
    return 'outer_layer';
  }
  return null;
}

function computeStabilityMultiplier(itemA, itemB) {
  const perms = [itemA?.permanence, itemB?.permanence];
  if (perms.some((p) => p === 'removable')) {
    return 0.3;
  }
  if (perms.some((p) => p === 'possibly_removable')) {
    return 0.6;
  }
  return 1;
}

function buildClothingMetrics(itemA, itemB, visibilityFactor, lightingUncertainty) {
  if (!isUsableClothingItem(itemA) || !isUsableClothingItem(itemB)) {
    return null;
  }
  const econf = effectiveConfidence(itemA.confidence, itemB.confidence) * visibilityFactor;
  if (econf <= 0) {
    return null;
  }
  return {
    econf,
    stabilityMultiplier: computeStabilityMultiplier(itemA, itemB),
    colorOk: areColorsEquivalent(itemA.color, itemB.color, lightingUncertainty),
    descOk: substringTokenMatch(itemA.description, itemB.description),
    isStableA: itemA.permanence === 'stable',
    isStableB: itemB.permanence === 'stable'
  };
}

function computeClothingContribution({ basePro, baseContra, metrics, allowContra = true }) {
  if (!metrics || basePro <= 0) {
    return {
      matchScore: 0,
      proColor: 0,
      proDesc: 0,
      contra: 0
    };
  }

  let matchScore = 0;
  let proColor = 0;
  let proDesc = 0;
  if (metrics.colorOk) {
    proColor = basePro * COLOR_MATCH_WEIGHT * metrics.stabilityMultiplier * metrics.econf;
    matchScore += COLOR_MATCH_WEIGHT;
  }
  if (metrics.descOk) {
    proDesc = basePro * TYPE_MATCH_WEIGHT * metrics.stabilityMultiplier * metrics.econf;
    matchScore += TYPE_MATCH_WEIGHT;
  }

  let contra = 0;
  if (
    allowContra &&
    metrics.isStableA &&
    metrics.isStableB &&
    baseContra > 0 &&
    matchScore <= CONTRA_MISMATCH_THRESHOLD
  ) {
    contra = baseContra * (1 - matchScore) * metrics.econf;
  }

  return {
    matchScore,
    proColor,
    proDesc,
    contra
  };
}

function collectGarmentsByCategory(clothing, targetCategory) {
  if (!clothing || typeof clothing !== 'object') {
    return [];
  }
  const garments = [];
  for (const slot of ['top', 'jacket']) {
    const item = clothing[slot];
    if (!isUsableClothingItem(item)) continue;
    const category = getGarmentCategory(slot, item.description);
    if (category === targetCategory) {
      garments.push({ slot, item });
    }
  }
  return garments;
}

function scoreCrossSlotOuterMatches({
  newClothing,
  groupClothing,
  visibilityFactor,
  lightingUncertainty,
  breakdown
}) {
  const newOuter = collectGarmentsByCategory(newClothing, 'outer_layer');
  const groupOuter = collectGarmentsByCategory(groupClothing, 'outer_layer');
  if (!newOuter.length || !groupOuter.length) {
    return 0;
  }

  const usedGroupIndices = new Set();
  let totalPro = 0;

  for (const newEntry of newOuter) {
    let bestMatch = null;
    let bestIndex = -1;
    for (let i = 0; i < groupOuter.length; i += 1) {
      if (usedGroupIndices.has(i)) continue;
      const groupEntry = groupOuter[i];
      if (newEntry.slot === groupEntry.slot) continue; // already handled by direct slot comparison

      const metrics = buildClothingMetrics(
        newEntry.item,
        groupEntry.item,
        visibilityFactor,
        lightingUncertainty
      );
      if (!metrics) continue;

      const basePro =
        (STABLE_CLOTHING_PRO_WEIGHTS[newEntry.slot] || 0) +
        (STABLE_CLOTHING_PRO_WEIGHTS[groupEntry.slot] || 0) +
        CROSS_SLOT_OUTER_LAYER_BONUS;
      if (basePro <= 0) continue;

      const contribution = computeClothingContribution({
        basePro,
        baseContra: 0,
        metrics,
        allowContra: false
      });
      const proTotal = contribution.proColor + contribution.proDesc;
      if (proTotal <= 0) continue;

      if (!bestMatch || proTotal > bestMatch) {
        bestMatch = contribution;
        bestIndex = i;
      }
    }

    if (bestMatch && bestIndex >= 0) {
      usedGroupIndices.add(bestIndex);
      const proTotal = bestMatch.proColor + bestMatch.proDesc;
      breakdown.clothingPro += proTotal;
      totalPro += proTotal;
    }
  }

  return totalPro;
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
    breakdown: createEmptyBreakdown()
  };
  }

  const breakdown = createEmptyBreakdown();
  let clothingProAccumulator = 0;

  let proScore = 0;
  let contraScore = 0;
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
    for (const slot of CLOTHING_SLOTS) {
      const newSlot = newClothing[slot];
      const groupSlot = groupClothing[slot];
      if (!isUsableClothingItem(newSlot) || !isUsableClothingItem(groupSlot)) {
        continue;
      }

      const newCategory = getGarmentCategory(slot, newSlot.description);
      const groupCategory = getGarmentCategory(slot, groupSlot.description);
      if (newCategory && groupCategory && newCategory !== groupCategory) {
        // Different garment categories mapped into the same slot (e.g., shirt vs. blazer) – skip penalizing.
        continue;
      }

      const metrics = buildClothingMetrics(newSlot, groupSlot, visibilityFactor, lightingUncertainty);
      if (!metrics) continue;

      const basePro = STABLE_CLOTHING_PRO_WEIGHTS[slot] || 0;
      const baseContra = STABLE_CLOTHING_CONTRA_WEIGHTS[slot] || 0;
      const contribution = computeClothingContribution({
        basePro,
        baseContra,
        metrics
      });
      const proTotal = contribution.proColor + contribution.proDesc;
        if (proTotal > 0) {
          clothingProAccumulator += proTotal;
          breakdown.clothingPro += proTotal;
        }
      if (contribution.contra > 0) {
        contraScore += contribution.contra;
        breakdown.clothingContra += contribution.contra;
      }
    }

  const outerLayerBonus = scoreCrossSlotOuterMatches({
    newClothing,
    groupClothing,
    visibilityFactor,
    lightingUncertainty,
    breakdown
  });
  if (outerLayerBonus > 0) {
    clothingProAccumulator += outerLayerBonus;
  }

  const clothingProApplied = Math.min(clothingProAccumulator, CLOTHING_PRO_CAP);
  if (clothingProApplied > 0) {
    proScore += clothingProApplied;
  }
  breakdown.clothingProRaw = clothingProAccumulator;
  breakdown.clothingProApplied = clothingProApplied;

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
      let missingConfidence = 0;
      for (const nm of newMarks) {
        if (!nm || typeof nm !== 'object') continue;
        if (gmType && nm.type && gmType !== nm.type) continue;
        const desc = normalizeText(nm.description);
        if (desc && desc !== 'unknown' && !hasAbsenceKeyword(desc)) continue;
        const econfMissing = effectiveConfidence(nm.confidence, gmConf) * visibilityFactor;
        if (econfMissing > missingConfidence) {
          missingConfidence = econfMissing;
        }
      }
      if (missingConfidence > 0) {
        const contraContrib = RARE_CONTRA_BASE * (rarity / 100) * missingConfidence;
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
          // Gender mismatch is near-fatal (handled earlier by fatal gate but still penalize).
          const fatalContra = (PHYSICAL_CONTRA_WEIGHTS.gender_presentation || 120) * econf;
          contraScore += fatalContra;
          breakdown.physicalContra += fatalContra;
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
    breakdown
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
              'Follow the description_schema exactly.',
              'Provide a top-level image_clarity integer (0–100) representing visual sharpness and unobstructed view (0 = unusable/blurry, 100 = perfect).'
            ].join(' ')
          },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: [
                  'Describe the person in this cropped photo. Produce only JSON with shape {"description_schema": {...}, "image_clarity": 0-100} that matches this schema:',
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
                  'image_clarity must be an integer 0–100 (0 = unusable/blurry, 100 = perfectly sharp).',
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

    const clarityValue = sanitizeClarity(parsed?.image_clarity);
    if (clarityValue === null) {
      console.warn('Single selection image_clarity missing or invalid.');
      return null;
    }
    schema.image_clarity = clarityValue;

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

  const newClarity = computeSchemaClarity(newDescriptionSchema);
  const scored = [];
  for (const group of existingGroups) {
    if (!group || typeof group !== 'object') continue;
    const canonical = group.group_canonical;
    if (!canonical || typeof canonical !== 'object') continue;
    const groupId = group.group_id;
    const memberCount = Number(group.group_member_count) || 0;
    const groupClarity = computeSchemaClarity(canonical);

    const fatalMismatch = detectFatalMismatch(newDescriptionSchema, canonical);
    if (fatalMismatch) {
      scored.push({
        groupId,
        memberCount,
        proScore: 0,
        contraScore: Number.POSITIVE_INFINITY,
        normPro: 0,
        normContra: NORMALIZED_SCORE_SCALE,
        probability: 0,
        breakdown: createEmptyBreakdown(),
        fatalMismatch,
        groupClarity
      });
      continue;
    }

    const { proScore, contraScore, breakdown } =
      computeProContraScores(newDescriptionSchema, canonical);
    const normPro = normalizeScore(proScore, PRO_SOFT_MAX);
    const normContra = normalizeScore(contraScore, CONTRA_SOFT_MAX);
    const probability = computeNormalizedProbability(normPro, normContra);

    scored.push({
      groupId,
      memberCount,
      proScore,
      contraScore,
      normPro,
      normContra,
      probability,
      breakdown,
      fatalMismatch: null,
      groupClarity
    });
  }

  if (!scored.length) {
    return {
      bestGroupId: null,
      bestGroupProbability: 0,
      explanation: ''
    };
  }

  // Apply normalized gates.
  const survivors = scored.filter(
    (g) => !g.fatalMismatch && g.normPro >= NORM_PRO_MIN && g.normContra <= NORM_CONTRA_MAX
  );
  let shortlist = [];

  if (!survivors.length) {
    // Find the best overall candidate for explanation purposes.
    // Prioritize non-fatal groups, then sort by proScore.
    scored.sort((a, b) => {
      const aFatal = a.fatalMismatch ? 1 : 0;
      const bFatal = b.fatalMismatch ? 1 : 0;
      if (aFatal !== bFatal) {
        return aFatal - bFatal; // non-fatal first
      }
      return b.proScore - a.proScore;
    });
    const candidate = scored[0];
    let explanation = '';
    if (candidate?.fatalMismatch) {
      explanation = formatFatalMismatchMessage(candidate.fatalMismatch);
    } else if (candidate) {
      explanation = `No group passed thresholds. Best candidate had proScore=${Math.round(candidate.proScore)}, contraScore=${Math.round(candidate.contraScore)}.`;
    }

    const fallbackGroup = (() => {
      if (!candidate || candidate.fatalMismatch) {
        return null;
      }
      if (newClarity < MIN_CLARITY_FOR_FATAL_HAIR) {
        return null;
      }
      const clarityEdge = typeof candidate.groupClarity === 'number'
        ? newClarity >= candidate.groupClarity + CLARITY_OVERRIDE_DELTA
        : false;
      const proStrong = candidate.proScore >= CLARITY_OVERRIDE_PRO_MIN;
      const contraAcceptable = candidate.contraScore <= CLARITY_OVERRIDE_CONTRA_MAX;
      if (clarityEdge && proStrong && contraAcceptable) {
        return candidate;
      }
      return null;
    })();

    if (fallbackGroup) {
      const fallbackNormPro = toOneDecimal(fallbackGroup.normPro);
      const fallbackNormContra = toOneDecimal(fallbackGroup.normContra);
      const fallbackProbability = Math.max(GROUPING_MATCH_THRESHOLD, computeNormalizedProbability(
        normalizeScore(fallbackGroup.proScore, PRO_SOFT_MAX),
        normalizeScore(fallbackGroup.contraScore, CONTRA_SOFT_MAX)
      ));
      const fallbackBd = fallbackGroup.breakdown || {};
      const fbClothingPro = Math.round(fallbackBd.clothingPro || 0);
      const fbPhysicalPro = Math.round(fallbackBd.physicalPro || 0);
      const fbHairPro = Math.round(fallbackBd.hairPro || 0);
      const fbRarePro = Math.round(fallbackBd.rarePro || 0);
      const fbProParts = [];
      const fbProDetails = [];
      if (fbClothingPro > 0) {
        fbProParts.push(`clothing ${fbClothingPro}`);
        fbProDetails.push({ category: 'clothing', value: fbClothingPro });
      }
      if (fbPhysicalPro > 0) {
        fbProParts.push(`physical ${fbPhysicalPro}`);
        fbProDetails.push({ category: 'physical', value: fbPhysicalPro });
      }
      if (fbHairPro > 0) {
        fbProParts.push(`hair ${fbHairPro}`);
        fbProDetails.push({ category: 'hair', value: fbHairPro });
      }
      if (fbRarePro > 0) {
        fbProParts.push(`rare ${fbRarePro}`);
        fbProDetails.push({ category: 'rare', value: fbRarePro });
      }
      const fbClothingContra = Math.round(fallbackBd.clothingContra || 0);
      const fbPhysicalContra = Math.round(fallbackBd.physicalContra || 0);
      const fbHairContra = Math.round(fallbackBd.hairContra || 0);
      const fbRareContra = Math.round(fallbackBd.rareContra || 0);
      const fbContraParts = [];
      const fbContraDetails = [];
      if (fbClothingContra > 0) {
        fbContraParts.push(`clothing ${fbClothingContra}`);
        fbContraDetails.push({ category: 'clothing', value: fbClothingContra });
      }
      if (fbPhysicalContra > 0) {
        fbContraParts.push(`physical ${fbPhysicalContra}`);
        fbContraDetails.push({ category: 'physical', value: fbPhysicalContra });
      }
      if (fbHairContra > 0) {
        fbContraParts.push(`hair ${fbHairContra}`);
        fbContraDetails.push({ category: 'hair', value: fbHairContra });
      }
      if (fbRareContra > 0) {
        fbContraParts.push(`rare ${fbRareContra}`);
        fbContraDetails.push({ category: 'rare', value: fbRareContra });
      }
      const fallbackPro = Math.round(fallbackGroup.proScore);
      const fallbackContra = Math.round(fallbackGroup.contraScore);
      const clarityNote = `Clarity override: new image_clarity ${newClarity} vs canonical ${fallbackGroup.groupClarity ?? 'unknown'}.`;
      const fallbackExplanation = [
        explanation,
        `Fallback candidate raw scores: pro=${fallbackPro}, contra=${fallbackContra}.`,
        `Pros: ${fbProParts.length ? fbProParts.join(', ') : 'none'}.`,
        `Contras: ${fbContraParts.length ? fbContraParts.join(', ') : 'none'}.`,
        `Normalized fallback scores: normPro=${fallbackNormPro}, normContra=${fallbackNormContra}, probability=${fallbackProbability}%.`,
        clarityNote,
        `Assigned to group ${fallbackGroup.groupId} despite thresholds due to stronger clarity and near-match scores.`
      ].filter(Boolean).join(' ');
      const fallbackDetails = {
        rawScores: { pro: fallbackPro, contra: fallbackContra },
        normalized: {
          normPro: fallbackNormPro,
          normContra: fallbackNormContra,
          probability: fallbackProbability,
          requiredNormPro: NORM_PRO_MIN,
          requiredNormContra: NORM_CONTRA_MAX
        },
        proContributions: fbProDetails,
        contraContributions: fbContraDetails,
        clarity: {
          newImage: Number.isFinite(newClarity) ? newClarity : null,
          canonical: typeof fallbackGroup.groupClarity === 'number' ? fallbackGroup.groupClarity : null
        },
        fallbackApplied: true,
        fallbackReason: 'clarity_override'
      };
      fallbackGroup.fallbackReason = 'clarity_override';
      return {
        bestGroupId: fallbackGroup.groupId,
        bestGroupProbability: fallbackProbability,
        explanation: fallbackExplanation.trim(),
        explanationDetails: fallbackDetails,
        shortlist,
        bestCandidate: fallbackGroup,
        bestCandidateDetails: fallbackDetails
      };
    }

    const candidateDetails = candidate
      ? buildCandidateDetails(candidate, newClarity, candidate?.probability || 0)
      : null;
    return {
      bestGroupId: null,
      bestGroupProbability: 0,
      explanation,
      explanationDetails: candidateDetails,
      shortlist,
      bestCandidate: candidate || null,
      bestCandidateDetails: candidateDetails
    };
  }

  survivors.sort((a, b) => {
    if (b.probability !== a.probability) {
      return b.probability - a.probability;
    }
    if (b.normPro !== a.normPro) {
      return b.normPro - a.normPro;
    }
    if (a.normContra !== b.normContra) {
      return a.normContra - b.normContra;
    }
    if (b.memberCount !== a.memberCount) {
      return b.memberCount - a.memberCount;
    }
    return 0;
  });
  shortlist = survivors.slice(0, TEXT_SHORTLIST_LIMIT).map((entry) => ({
    groupId: entry.groupId,
    probability: entry.probability,
    normPro: toOneDecimal(entry.normPro),
    normContra: toOneDecimal(entry.normContra),
    proScore: Math.round(entry.proScore),
    contraScore: Math.round(entry.contraScore),
    memberCount: entry.memberCount
  }));
  const top = survivors[0];
  const tied = survivors.filter((g) => Math.abs(top.probability - g.probability) <= TIE_DELTA);

  let best = top;
  if (tied.length > 1) {
    tied.sort((a, b) => {
      // Prefer groups with lower normalized contra, then higher member count.
      if (a.normContra !== b.normContra) {
        return a.normContra - b.normContra;
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
  const normPro = toOneDecimal(best.normPro);
  const normContra = toOneDecimal(best.normContra);
  const bestProbability = best.probability;

  const bd = best.breakdown || {};
  const clothingPro = Math.round(bd.clothingPro || 0);
  const physicalPro = Math.round(bd.physicalPro || 0);
  const hairPro = Math.round(bd.hairPro || 0);
  const rarePro = Math.round(bd.rarePro || 0);

  const clothingContra = Math.round(bd.clothingContra || 0);
  const physicalContra = Math.round(bd.physicalContra || 0);
  const hairContra = Math.round(bd.hairContra || 0);
  const rareContra = Math.round(bd.rareContra || 0);

  let clothingCapNote = '';
  if (
    typeof bd.clothingProRaw === 'number' &&
    typeof bd.clothingProApplied === 'number' &&
    bd.clothingProRaw > bd.clothingProApplied
  ) {
    clothingCapNote = ` (capped at ${Math.round(bd.clothingProApplied)} of ${Math.round(bd.clothingProRaw)})`;
  }
  const proParts = [];
  if (clothingPro > 0) proParts.push(`clothing ${clothingPro}${clothingCapNote}`);
  if (physicalPro > 0) proParts.push(`physical ${physicalPro}`);
  if (hairPro > 0) proParts.push(`hair ${hairPro}`);
  if (rarePro > 0) proParts.push(`rare ${rarePro}`);

  const contraParts = [];
  if (clothingContra > 0) contraParts.push(`clothing ${clothingContra}`);
  if (physicalContra > 0) contraParts.push(`physical ${physicalContra}`);
  if (hairContra > 0) contraParts.push(`hair ${hairContra}`);
  if (rareContra > 0) contraParts.push(`rare ${rareContra}`);

  const proContributionDetails = [];
  if (clothingPro > 0) {
    proContributionDetails.push({
      category: 'clothing',
      value: clothingPro,
      note: clothingCapNote ? clothingCapNote.trim() : null
    });
  }
  if (physicalPro > 0) proContributionDetails.push({ category: 'physical', value: physicalPro });
  if (hairPro > 0) proContributionDetails.push({ category: 'hair', value: hairPro });
  if (rarePro > 0) proContributionDetails.push({ category: 'rare', value: rarePro });

  const contraContributionDetails = [];
  if (clothingContra > 0) contraContributionDetails.push({ category: 'clothing', value: clothingContra });
  if (physicalContra > 0) contraContributionDetails.push({ category: 'physical', value: physicalContra });
  if (hairContra > 0) contraContributionDetails.push({ category: 'hair', value: hairContra });
  if (rareContra > 0) contraContributionDetails.push({ category: 'rare', value: rareContra });

  const proText = proParts.length ? proParts.join(', ') : 'none';
  const contraText = contraParts.length ? contraParts.join(', ') : 'none';
  const clarityLine = typeof best.groupClarity === 'number'
    ? `Image clarity — new=${newClarity || 'unknown'}, canonical=${best.groupClarity}.`
    : null;
  const explanation = [
    `Raw scores: pro=${pro}, contra=${contra}.`,
    `Pro contributions: ${proText}.`,
    `Contra penalties: ${contraText}.`,
    `Normalized scores: normPro=${normPro} (needs ≥${NORM_PRO_MIN}), normContra=${normContra} (needs ≤${NORM_CONTRA_MAX}), probability=${bestProbability}%.`,
    clarityLine
  ].filter(Boolean).join(' ');

  const explanationDetails = buildCandidateDetails(best, newClarity, bestProbability) || {
    rawScores: { pro, contra },
    normalized: {
      normPro,
      normContra,
      probability: bestProbability,
      requiredNormPro: NORM_PRO_MIN,
      requiredNormContra: NORM_CONTRA_MAX
    },
    proContributions: proContributionDetails,
    contraContributions: contraContributionDetails,
    clarity: {
      newImage: Number.isFinite(newClarity) ? newClarity : null,
      canonical: typeof best.groupClarity === 'number' ? best.groupClarity : null
    },
    fallbackApplied: false,
    fallbackReason: null
  };

  return {
    bestGroupId: best.groupId ?? null,
    bestGroupProbability: bestProbability,
    explanation,
    explanationDetails,
    shortlist,
    bestCandidate: best,
    bestCandidateDetails: explanationDetails
  };
}

module.exports = {
  generateStablePersonDescription,
  evaluateDescriptionGrouping,
  GROUPING_MATCH_THRESHOLD,
  computeProContraScores,
  computeSchemaClarity
};

