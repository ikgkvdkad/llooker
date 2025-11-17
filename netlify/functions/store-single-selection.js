const {
  getDatabasePool,
  ensureSingleCameraSelectionsTable,
  SINGLE_CAMERA_SELECTIONS_TABLE_NAME
} = require('./shared/db.js');
const {
  generateStablePersonDescription,
  evaluateDescriptionGrouping,
  GROUPING_MATCH_THRESHOLD
} = require('./shared/single-description.js');
const { verifyShortlistWithVision } = require('./shared/vision-verification.js');
const {
  collectGroupsWithRepresentatives,
  buildVisionSummary
} = require('./shared/grouping-helpers.js');
const {
  packExplanationWithDetails,
  summarizeBestCandidate
} = require('./shared/grouping-explanation.js');

function cloneDetails(details) {
  if (!details || typeof details !== 'object') {
    return null;
  }
  try {
    return JSON.parse(JSON.stringify(details));
  } catch (error) {
    console.warn('Failed to clone grouping details payload.', error);
    return { ...details };
  }
}

function sanitizeViewport(viewport) {
  if (!viewport || typeof viewport !== 'object') {
    return null;
  }
  try {
    return JSON.parse(JSON.stringify(viewport));
  } catch {
    return null;
  }
}


exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  const pool = getDatabasePool();
  if (!pool) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Database not configured.' })
    };
  }

  try {
    await ensureSingleCameraSelectionsTable(pool);
  } catch (error) {
    console.error('Failed to ensure single camera selections table:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Failed to prepare single selection storage.' })
    };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Invalid JSON body.' })
    };
  }

  const imageDataUrl = typeof payload?.imageDataUrl === 'string' ? payload.imageDataUrl : '';
  if (!imageDataUrl.startsWith('data:image/')) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'imageDataUrl must be a valid data URL.' })
    };
  }

  const viewport = sanitizeViewport(payload.viewport);
  const capturedAt = payload.capturedAt ? new Date(payload.capturedAt) : null;
  const capturedAtIso = capturedAt instanceof Date && !Number.isNaN(capturedAt.getTime())
    ? capturedAt.toISOString()
    : null;
  const signature = typeof payload.signature === 'string' ? payload.signature.slice(0, 512) : null;
  const mode = typeof payload.mode === 'string' ? payload.mode.trim().toLowerCase().slice(0, 32) : 'single';

  const descriptionResult = await generateStablePersonDescription(imageDataUrl);

  let personGroupIdForInsert = null;
  let groupingProbabilityForInsert = null;
  let groupingExplanationForInsert = null;
  let groupingExplanationTextForResponse = null;
  let groupingExplanationDetailsForResponse = null;
  let bestCandidateSummaryForResponse = null;
  let groupsMap = new Map();
  let shortlist = [];
  let visionOutcome = null;

  try {
    // Build canonical descriptions per existing person group using structured description_json.
      const groupsResult = await pool.query(
        `
        SELECT id,
               person_group_id,
               description_json,
               image_data_url,
               captured_at,
               created_at
        FROM ${SINGLE_CAMERA_SELECTIONS_TABLE_NAME}
        WHERE description_json IS NOT NULL
          AND person_group_id IS NOT NULL
        `
      );

      const rows = groupsResult.rows || [];
      const collection = collectGroupsWithRepresentatives(rows);
      const groups = collection.groups;
      groupsMap = collection.groupsMap;

      const groupingResult = await evaluateDescriptionGrouping(
        descriptionResult ? descriptionResult.schema : null,
        groups
      );
      const bestGroupId = Number.isFinite(Number(groupingResult.bestGroupId))
        ? Number(groupingResult.bestGroupId)
        : null;
      const bestGroupProbability = Number.isFinite(Number(groupingResult.bestGroupProbability))
        ? Math.max(0, Math.min(100, Math.round(Number(groupingResult.bestGroupProbability))))
        : null;
      const explanation = groupingResult.explanation && typeof groupingResult.explanation === 'string'
        ? groupingResult.explanation.trim()
        : '';
      groupingExplanationDetailsForResponse = cloneDetails(
        groupingResult.explanationDetails || groupingResult.bestCandidateDetails || null
      );
      shortlist = Array.isArray(groupingResult.shortlist) ? groupingResult.shortlist : [];

      let finalGroupId = bestGroupId;
      let finalProbability = bestGroupProbability;
      const explanationPieces = [];
      if (explanation) {
        explanationPieces.push(explanation);
      }

      if (shortlist.length) {
        try {
          visionOutcome = await verifyShortlistWithVision({
            shortlist,
            newSelection: {
              imageDataUrl,
              descriptionSchema: descriptionResult ? descriptionResult.schema : null,
              capturedAt: capturedAtIso
            },
            groupsById: groupsMap
          });
        } catch (visionError) {
          console.error('Vision verification failed for single selection:', {
            message: visionError?.message,
            stack: visionError?.stack
          });
          visionOutcome = {
            approvedGroupId: null,
            comparisons: [],
            applied: true,
            reason: 'vision_exception',
            error: visionError?.message || 'Vision helper crashed'
          };
        }

        const visionSummary = buildVisionSummary(visionOutcome, groupsMap);
        if (visionSummary) {
          explanationPieces.push(visionSummary);
        }

        if (!visionOutcome?.applied) {
          finalGroupId = null;
          finalProbability = 0;
        } else if (visionOutcome.approvedGroupId) {
          finalGroupId = visionOutcome.approvedGroupId;
        } else {
          finalGroupId = null;
          finalProbability = 0;
        }
      }

      if (finalGroupId) {
        personGroupIdForInsert = finalGroupId;
      }

      const bestCandidateSummary = summarizeBestCandidate(
        groupingResult.bestCandidate,
        groupsMap
      );
      bestCandidateSummaryForResponse = bestCandidateSummary;

      if (bestCandidateSummaryForResponse) {
        if (!groupingExplanationDetailsForResponse || typeof groupingExplanationDetailsForResponse !== 'object') {
          groupingExplanationDetailsForResponse = {};
        }
        groupingExplanationDetailsForResponse.bestCandidate = bestCandidateSummaryForResponse;
      }

      groupingProbabilityForInsert = finalProbability;
      const combinedExplanation = explanationPieces.filter(Boolean).join(' ').trim();
      groupingExplanationTextForResponse = combinedExplanation || null;
      groupingExplanationForInsert = combinedExplanation
        ? packExplanationWithDetails(combinedExplanation, groupingExplanationDetailsForResponse)
        : null;

      // Keep only lightweight debug data for the client
      var groupingDebugForResponse = {
        newDescription: descriptionResult ? descriptionResult.schema : null,
        groups,
        shortlist,
        bestGroupId,
        bestGroupProbability,
        explanation: groupingExplanationTextForResponse,
        explanationDetails: groupingExplanationDetailsForResponse || null,
        bestCandidate: bestCandidateSummaryForResponse || groupingResult.bestCandidate || null,
        vision: visionOutcome
      };
  } catch (groupingError) {
    console.error('Failed to evaluate grouping for single selection:', {
      message: groupingError?.message,
      stack: groupingError?.stack
    });
    // Fall back to treating this as a new group; personGroupIdForInsert stays null.
  }

  const hasStructuredDescription = descriptionResult && descriptionResult.schema && descriptionResult.naturalSummary;

  const insertQuery = {
    text: `
        INSERT INTO ${SINGLE_CAMERA_SELECTIONS_TABLE_NAME} (role, image_data_url, viewport, signature, captured_at, description, description_json, person_group_id, grouping_probability, grouping_explanation)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING id, created_at, captured_at, role, description, description_json, person_group_id, grouping_probability, grouping_explanation
    `,
    values: [
      mode || 'single',
      imageDataUrl,
      viewport ? JSON.stringify(viewport) : null,
      signature,
        capturedAtIso,
      hasStructuredDescription ? descriptionResult.naturalSummary : null,
      hasStructuredDescription ? JSON.stringify(descriptionResult.schema) : null,
      personGroupIdForInsert,
      groupingProbabilityForInsert,
      groupingExplanationForInsert
    ]
  };

  try {
    const result = await pool.query(insertQuery);
    const record = result.rows?.[0];

    let finalGroupId = record?.person_group_id ?? null;

    // If this was a new person (no group match), use the selection id as its group id.
    if (!finalGroupId && record?.id) {
      finalGroupId = record.id;
      try {
        await pool.query(
          `
          UPDATE ${SINGLE_CAMERA_SELECTIONS_TABLE_NAME}
          SET person_group_id = $1
          WHERE id = $2
          `,
          [finalGroupId, record.id]
        );
      } catch (updateError) {
        console.error('Failed to assign person_group_id for new single selection:', {
          id: record.id,
          message: updateError?.message,
          stack: updateError?.stack
        });
      }
    }

    return {
      statusCode: 201,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        groupingDebug: typeof groupingDebugForResponse === 'object' ? groupingDebugForResponse : null,
        selection: {
          id: record?.id ?? null,
          createdAt: record?.created_at ?? null,
          capturedAt: record?.captured_at ?? null,
          role: record?.role ?? null,
          description: record?.description ?? null,
          descriptionSchema: record?.description_json ?? null,
          personGroupId: finalGroupId ?? null,
          groupingProbability: record?.grouping_probability ?? null,
          groupingExplanation: groupingExplanationTextForResponse,
          groupingExplanationDetails: groupingExplanationDetailsForResponse || null,
          bestCandidate: bestCandidateSummaryForResponse || null
        }
      })
    };
  } catch (error) {
    console.error('Failed to store single camera selection:', {
      message: error?.message,
      stack: error?.stack
    });
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Failed to store single selection.' })
    };
  }
};


