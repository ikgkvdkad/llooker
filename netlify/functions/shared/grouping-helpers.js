function extractClarity(description) {
  if (!description || typeof description !== 'object') {
    return 0;
  }
  const base = Number(description.image_clarity);
  const normalizedBase = Number.isFinite(base) ? Math.max(0, Math.min(100, base)) : 0;

  const scoreField = (obj, weight = 5) => {
    if (!obj || typeof obj !== 'object') return 0;
    const value = obj.value;
    const confidence = Number(obj.confidence);
    if (typeof value !== 'string' || !value || value === 'unknown') return 0;
    if (!Number.isFinite(confidence) || confidence < 50) return 0;
    return Math.min(weight, (confidence / 100) * weight);
  };

  const hairScore =
    scoreField(description.hair?.color, 10) +
    scoreField(description.hair?.length, 4) +
    scoreField(description.hair?.facial_hair, 4);

  const physicalScore =
    scoreField(description.gender_presentation, 6) +
    scoreField(description.age_band, 6) +
    scoreField(description.build, 4) +
    scoreField(description.skin_tone, 4) +
    scoreField(description.height_impression, 2);

  const clothingSlots = ['top', 'trousers', 'shoes', 'jacket', 'dress'];
  const clothingScore = clothingSlots.reduce((sum, slot) => {
    const part = description.clothing?.[slot];
    if (!part || typeof part !== 'object') return sum;
    const colorScore = scoreField({ value: part.color, confidence: part.confidence }, 8);
    const descScore = typeof part.description === 'string' && part.description
      ? Math.min(5, ((Number(part.confidence) || 0) / 100) * 5)
      : 0;
    return sum + colorScore + descScore;
  }, 0);

  const accessoryScore = Array.isArray(description.accessories)
    ? Math.min(10, description.accessories.reduce((acc, item) => {
        if (!item || typeof item !== 'object') return acc;
        const conf = Number(item.confidence);
        if (!Number.isFinite(conf) || conf < 50) return acc;
        return acc + 2;
      }, 0))
    : 0;

  const distinctivenessScore = Number(description.distinctiveness_score);
  const distinctScore = Number.isFinite(distinctivenessScore)
    ? Math.min(10, distinctivenessScore / 10)
    : 0;

  const coverageBonus = (() => {
    const fields = [
      description.hair?.color?.value,
      description.hair?.length?.value,
      description.gender_presentation?.value,
      description.age_band?.value,
      description.build?.value,
      description.skin_tone?.value,
      description.clothing?.top?.description,
      description.clothing?.trousers?.description,
      description.clothing?.shoes?.description
    ];
    const filled = fields.filter((v) => typeof v === 'string' && v && v !== 'unknown').length;
    return Math.min(15, filled * 2);
  })();

  const composite = normalizedBase + hairScore + physicalScore + clothingScore + accessoryScore + distinctScore + coverageBonus;
  return Math.max(0, Math.min(100, Math.round(composite)));
}

function collectGroupsWithRepresentatives(rows) {
  const groupsMap = new Map();
  for (const row of rows) {
    const groupId = row.person_group_id;
    const canonical = row.description_json;
    if (!groupId || !canonical) continue;
    const key = String(groupId);
    const clarity = extractClarity(canonical);
    const captured = row.captured_at || row.created_at || null;
    const capturedIso = captured instanceof Date && !Number.isNaN(captured.getTime())
      ? captured.toISOString()
      : (typeof captured === 'string' ? captured : null);
    let entry = groupsMap.get(key);
    if (!entry) {
      entry = {
        group_id: groupId,
        group_canonical: canonical,
        group_member_count: 0,
        representativeImage: row.image_data_url || null,
        representativeCapturedAt: capturedIso,
        representativeSelectionId: row.id || null,
        best_clarity: clarity
      };
      groupsMap.set(key, entry);
    }
    entry.group_member_count += 1;

    const shouldReplaceCanonical = typeof entry.best_clarity !== 'number' || clarity > entry.best_clarity;
    if (shouldReplaceCanonical) {
      entry.group_canonical = canonical;
      entry.best_clarity = clarity;
      if (row.image_data_url) {
        entry.representativeImage = row.image_data_url;
        entry.representativeCapturedAt = capturedIso;
        entry.representativeSelectionId = row.id || null;
      }
    } else if (!entry.representativeImage && row.image_data_url) {
      entry.representativeImage = row.image_data_url;
      entry.representativeCapturedAt = capturedIso;
      entry.representativeSelectionId = row.id || null;
    }
  }

  const groups = [];
  for (const entry of groupsMap.values()) {
    groups.push({
      group_id: entry.group_id,
      group_canonical: entry.group_canonical,
      group_member_count: entry.group_member_count,
      representativeImage: entry.representativeImage || null,
      representativeSelectionId: entry.representativeSelectionId || null,
      representativeCapturedAt: entry.representativeCapturedAt || null,
      group_image_clarity: typeof entry.best_clarity === 'number' ? entry.best_clarity : null
    });
  }
  return { groups, groupsMap };
}

function formatDateLabel(value) {
  if (!value) {
    return 'time unknown';
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'time unknown';
  }
  return date.toLocaleString();
}

function sanitizeReasoningText(text) {
  if (typeof text !== 'string') {
    return '';
  }
  return text.replace(/\s+/g, ' ').trim();
}

function buildVisionSummary(visionOutcome, groupsMap) {
  if (!visionOutcome) {
    return '';
  }

  if (!visionOutcome.applied) {
    if (visionOutcome.reason === 'missing_api_key') {
      return 'Vision verification skipped: OpenAI API key not configured.';
    }
    if (visionOutcome.reason === 'empty_shortlist') {
      return '';
    }
    if (visionOutcome.reason === 'missing_candidate_image') {
      return 'Vision verification skipped: candidate image unavailable.';
    }
    return `Vision verification skipped: ${visionOutcome.reason || 'unknown reason'}.`;
  }

  if (!Array.isArray(visionOutcome.comparisons) || !visionOutcome.comparisons.length) {
    if (visionOutcome.error) {
      return `Vision verification failed: ${visionOutcome.error}`;
    }
    return 'Vision verification ran but produced no comparisons.';
  }

  const lines = visionOutcome.comparisons.map((comparison) => {
    if (comparison.skipped) {
      return `Vision check skipped for group ${comparison.groupId}: ${comparison.reason || 'unknown reason'}.`;
    }
    const groupMeta = groupsMap.get(String(comparison.groupId)) || {};
    const referenceLabel = groupMeta.representativeSelectionId
      ? `selection #${groupMeta.representativeSelectionId}`
      : `group ${comparison.groupId}`;
    const referenceTime = formatDateLabel(groupMeta.representativeCapturedAt);
    const newTime = formatDateLabel(comparison.newCapturedAt);
    const reasoning = sanitizeReasoningText(comparison.reasoning);
    const status = comparison.fatalMismatch
      ? `fatal mismatch (${comparison.fatalMismatch})`
      : `${comparison.similarity}% (${comparison.confidence || 'unknown'})`;
    const reasoningText = reasoning ? ` Reasoning: ${reasoning}` : '';
    return `Vision check vs ${referenceLabel} (${referenceTime}) using new capture (${newTime}): ${status}.${reasoningText}`;
  });

  if (visionOutcome.approvedGroupId) {
    lines.push(`Vision approval: group ${visionOutcome.approvedGroupId} confirmed.`);
  } else {
    lines.push('Vision verification rejected all shortlisted groups.');
  }

  return lines.join(' ');
}

module.exports = {
  collectGroupsWithRepresentatives,
  buildVisionSummary
};
