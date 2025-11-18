function extractClarity(description) {
  if (!description || typeof description !== 'object') {
    return 0;
  }
  
  const baseClarity = Number(description.image_clarity);
  if (!Number.isFinite(baseClarity)) {
    return 0;
  }
  
  // Count filled fields in new flat schema
  const fields = [
    description.gender,
    description.age_range,
    description.build,
    description.height,
    description.skin_tone,
    description.hair_color,
    description.hair_length,
    description.facial_hair,
    description.top_color,
    description.top_description,
    description.bottom_color,
    description.bottom_description,
    description.shoes_color,
    description.shoes_description
  ];
  
  const filled = fields.filter(v => v && v !== 'unknown').length;
  const total = fields.length;
  const completeness = (filled / total) * 100;
  
  // Blend base clarity with completeness
  return Math.round((baseClarity * 0.7) + (completeness * 0.3));
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
