const SENTINEL_START = '\n\n===SCORE_BREAKDOWN_JSON_START===\n';
const SENTINEL_END = '\n===SCORE_BREAKDOWN_JSON_END===\n';

function packExplanationWithDetails(explanation, details) {
  if (!details) {
    return explanation || '';
  }
  let serialized = null;
  try {
    serialized = JSON.stringify(details);
  } catch (error) {
    console.warn('Failed to serialize grouping explanation details.', error);
    return explanation || '';
  }
  return `${explanation || ''}${SENTINEL_START}${serialized}${SENTINEL_END}`;
}

function unpackExplanationWithDetails(packed) {
  if (typeof packed !== 'string' || !packed.length) {
    return { explanation: packed || '', details: null };
  }
  const startIndex = packed.indexOf(SENTINEL_START);
  const endIndex = packed.indexOf(SENTINEL_END);
  if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
    return { explanation: packed, details: null };
  }
  const explanationText = packed.slice(0, startIndex).trimEnd();
  const jsonSlice = packed
    .slice(startIndex + SENTINEL_START.length, endIndex)
    .trim();
  let details = null;
  if (jsonSlice) {
    try {
      details = JSON.parse(jsonSlice);
    } catch (error) {
      console.warn('Failed to parse grouping explanation details JSON.', error);
    }
  }
  const trailing = packed.slice(endIndex + SENTINEL_END.length).trim();
  const finalExplanation = trailing
    ? `${explanationText}\n${trailing}`.trim()
    : explanationText || packed.slice(0, startIndex);
  return {
    explanation: finalExplanation,
    details: details || null
  };
}

module.exports = {
  packExplanationWithDetails,
  unpackExplanationWithDetails,
  SENTINEL_START,
  SENTINEL_END
};


