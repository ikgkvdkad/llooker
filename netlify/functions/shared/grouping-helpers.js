function collectGroupsWithRepresentatives(rows) {
  const groupsMap = new Map();
  for (const row of rows) {
    const groupId = row.person_group_id;
    const canonical = row.description_json;
    if (!groupId || !canonical) continue;
    const key = String(groupId);
    let entry = groupsMap.get(key);
    if (!entry) {
      const captured = row.captured_at || row.created_at || null;
      const capturedIso = captured instanceof Date && !Number.isNaN(captured.getTime())
        ? captured.toISOString()
        : (typeof captured === 'string' ? captured : null);
      entry = {
        group_id: groupId,
        group_canonical: canonical,
        group_member_count: 0,
        representativeImage: row.image_data_url || null,
        representativeCapturedAt: capturedIso,
        representativeSelectionId: row.id || null
      };
      groupsMap.set(key, entry);
    }
    entry.group_member_count += 1;
    if (!entry.group_canonical && canonical) {
      entry.group_canonical = canonical;
    }
    if (!entry.representativeImage && row.image_data_url) {
      const captured = row.captured_at || row.created_at || null;
      const capturedIso = captured instanceof Date && !Number.isNaN(captured.getTime())
        ? captured.toISOString()
        : (typeof captured === 'string' ? captured : null);
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
      group_member_count: entry.group_member_count
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
