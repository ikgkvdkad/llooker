const OpenAI = require('openai');
const { schemaToVisionAnalysis } = require('./schema-to-analysis.js');

const VISION_SHORTLIST_LIMIT = (() => {
  const raw = Number(process.env.VISION_SHORTLIST_LIMIT);
  if (Number.isFinite(raw) && raw > 0) {
    return Math.floor(raw);
  }
  return 3;
})();
const VISION_ACCEPT_SIMILARITY = (() => {
  const raw = Number(process.env.VISION_ACCEPT_SIMILARITY);
  if (Number.isFinite(raw) && raw >= 0 && raw <= 100) {
    return raw;
  }
  return 90;
})();
const VISION_ACCEPT_CONFIDENCE = (process.env.VISION_ACCEPT_CONFIDENCE || 'high').toLowerCase();

const { performVisionMatch } = require('./vision-match.js');

function buildPhotoPayload(imageDataUrl, schema, capturedAt) {
  if (!imageDataUrl) {
    return null;
  }
  return {
    imageDataUrl,
    analysis: schemaToVisionAnalysis(schema) || {},
    discriminators: null,
    capturedAt: capturedAt || null
  };
}

function ensureMap(mapLike) {
  if (mapLike instanceof Map) {
    return mapLike;
  }
  const map = new Map();
  if (mapLike && typeof mapLike === 'object') {
    for (const [key, value] of Object.entries(mapLike)) {
      map.set(key, value);
    }
  }
  return map;
}

async function verifyShortlistWithVision({ shortlist, newSelection, groupsById }) {
  if (!Array.isArray(shortlist) || !shortlist.length) {
    return {
      approvedGroupId: null,
      comparisons: [],
      applied: false,
      reason: 'empty_shortlist'
    };
  }

  const apiKey = process.env.OPENAI_API_KEY || process.env.OPENAIKEY;
  if (!apiKey) {
    return {
      approvedGroupId: null,
      comparisons: [],
      applied: false,
      reason: 'missing_api_key'
    };
  }

  const candidatePhoto = buildPhotoPayload(
    newSelection?.imageDataUrl,
    newSelection?.descriptionSchema,
    newSelection?.capturedAt
  );
  if (!candidatePhoto) {
    return {
      approvedGroupId: null,
      comparisons: [],
      applied: false,
      reason: 'missing_candidate_image'
    };
  }

  const openai = new OpenAI({ apiKey });
  const comparisons = [];
  const groupMap = ensureMap(groupsById);
  const limit = Math.max(1, Math.min(VISION_SHORTLIST_LIMIT, shortlist.length));

  for (let index = 0; index < limit; index += 1) {
    const entry = shortlist[index];
    const groupMeta = groupMap.get(String(entry.groupId));
    if (!groupMeta || !groupMeta.representativeImage) {
      comparisons.push({
        groupId: entry.groupId,
        probability: entry.probability,
        skipped: true,
        reason: 'missing_reference_image'
      });
      continue;
    }

    const referencePhoto = buildPhotoPayload(
      groupMeta.representativeImage,
      groupMeta.group_canonical,
      groupMeta.representativeCapturedAt || groupMeta.representativeCreatedAt || null
    );
    if (!referencePhoto) {
      comparisons.push({
        groupId: entry.groupId,
        probability: entry.probability,
        skipped: true,
        reason: 'missing_reference_payload'
      });
      continue;
    }

    let result;
    try {
      // eslint-disable-next-line no-await-in-loop
      result = await performVisionMatch(openai, candidatePhoto, referencePhoto);
    } catch (error) {
      return {
        approvedGroupId: null,
        comparisons,
        applied: true,
        reason: 'vision_error',
        error: error?.message || 'Vision comparison failed'
      };
    }

    const comparisonRecord = {
      groupId: entry.groupId,
      probability: entry.probability,
      similarity: result.similarity,
      confidence: result.confidence,
      fatalMismatch: result.fatal_mismatch,
      reasoning: result.reasoning,
      newCapturedAt: newSelection?.capturedAt || null,
      referenceSelectionId: groupMeta.representativeSelectionId || null,
      referenceCapturedAt: groupMeta.representativeCapturedAt || null
    };
    comparisons.push(comparisonRecord);

    const passesSimilarity = result.similarity >= VISION_ACCEPT_SIMILARITY;
    const passesConfidence =
      VISION_ACCEPT_CONFIDENCE === 'any' || (result.confidence || '').toLowerCase() === 'high';
    const passesFatal = !result.fatal_mismatch;

    if (passesSimilarity && passesConfidence && passesFatal) {
      return {
        approvedGroupId: entry.groupId,
        comparisons,
        applied: true
      };
    }
  }

  return {
    approvedGroupId: null,
    comparisons,
    applied: true
  };
}

module.exports = {
  verifyShortlistWithVision
};
