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
  unpackExplanationWithDetails
} = require('./shared/grouping-explanation.js');

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
    console.error('Failed to ensure single camera selections table before single update:', error);
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

  const id = Number.isFinite(Number(payload?.id)) ? Number(payload.id) : null;
  if (!id || id <= 0) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'A valid numeric "id" is required.' })
    };
  }

  let row;
  try {
    const result = await pool.query(
      `
        SELECT id, image_data_url, description, person_group_id, grouping_probability, grouping_explanation
      FROM ${SINGLE_CAMERA_SELECTIONS_TABLE_NAME}
      WHERE id = $1
      `,
      [id]
    );
    row = result.rows?.[0] || null;
  } catch (error) {
    console.error('Failed to load single selection for description update:', {
      id,
      message: error?.message,
      stack: error?.stack
    });
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Failed to load selection for description update.' })
    };
  }

  if (!row) {
    return {
      statusCode: 404,
      body: JSON.stringify({ error: 'Selection not found.' })
    };
  }

  if (!row.image_data_url || typeof row.image_data_url !== 'string') {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Selection is missing stored image data.' })
    };
  }

  const selectionCapturedAtIso = (() => {
    const value = row.captured_at || null;
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return date.toISOString();
  })();

  let description;
  try {
    description = await generateStablePersonDescription(row.image_data_url);
  } catch (error) {
    console.error('Description generation failed for single selection:', {
      id,
      message: error?.message,
      stack: error?.stack
    });
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Failed to generate description for this selection.' })
    };
  }

  if (!description || !description.schema || !description.naturalSummary) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Description generation returned empty content for this selection.' })
    };
  }

  const existingExplanation = unpackExplanationWithDetails(row.grouping_explanation || '');
  let personGroupId = row.person_group_id || null;
  let groupingDebugForResponse = null;
  let groupingProbabilityForUpdate = null;
  let groupingExplanationPackedForUpdate = null;
  let groupingExplanationTextForResponse = existingExplanation.explanation || null;
  let groupingExplanationDetailsForResponse = existingExplanation.details || null;
  let groupsMap = new Map();
  let shortlist = [];
  let visionOutcome = null;

  try {
    // Only assign or re-evaluate a group using structured description.
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
            AND id <> $1
        `,
        [id]
      );

      const rows = groupsResult.rows || [];
      const collection = collectGroupsWithRepresentatives(rows);
      const groups = collection.groups;
      groupsMap = collection.groupsMap;

      const groupingResult = await evaluateDescriptionGrouping(description.schema, groups);
      const bestGroupId = Number.isFinite(Number(groupingResult.bestGroupId))
        ? Number(groupingResult.bestGroupId)
        : null;
      const bestGroupProbability = Number.isFinite(Number(groupingResult.bestGroupProbability))
        ? Math.max(0, Math.min(100, Math.round(Number(groupingResult.bestGroupProbability))))
        : null;
      const explanation = groupingResult.explanation && typeof groupingResult.explanation === 'string'
        ? groupingResult.explanation.trim()
        : '';
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
              imageDataUrl: row.image_data_url,
              descriptionSchema: description.schema,
              capturedAt: selectionCapturedAtIso
            },
            groupsById: groupsMap
          });
        } catch (visionError) {
          console.error('Vision verification failed for updated selection:', {
            id,
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
        personGroupId = finalGroupId;
      }

      groupingProbabilityForUpdate = finalProbability;
      const combinedExplanation = explanationPieces.filter(Boolean).join(' ').trim();
      groupingExplanationTextForResponse = combinedExplanation || null;
      groupingExplanationDetailsForResponse = groupingResult.explanationDetails || null;
      groupingExplanationPackedForUpdate = combinedExplanation
        ? packExplanationWithDetails(combinedExplanation, groupingExplanationDetailsForResponse)
        : null;

      groupingDebugForResponse = {
        newDescription: description.schema,
        groups,
        shortlist,
        bestGroupId,
        bestGroupProbability,
        explanation: groupingExplanationTextForResponse,
        explanationDetails: groupingExplanationDetailsForResponse,
        vision: visionOutcome
      };
  } catch (groupError) {
    console.error('Failed to evaluate grouping for updated single selection:', {
      id,
      message: groupError?.message,
      stack: groupError?.stack
    });
  }

    try {
    await pool.query(
      `
        UPDATE ${SINGLE_CAMERA_SELECTIONS_TABLE_NAME}
        SET description = $1,
            description_json = $2,
            person_group_id = COALESCE(person_group_id, $3),
            grouping_probability = COALESCE($4, grouping_probability),
            grouping_explanation = COALESCE($5, grouping_explanation)
        WHERE id = $6
      `,
      [
        description.naturalSummary,
        JSON.stringify(description.schema),
        personGroupId || null,
        groupingProbabilityForUpdate,
        groupingExplanationPackedForUpdate,
        id
      ]
    );
  } catch (error) {
    console.error('Failed to store updated description for single selection:', {
      id,
      message: error?.message,
      stack: error?.stack
    });
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Failed to store updated description for this selection.' })
    };
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id,
      description: description.naturalSummary,
      groupingProbability: groupingProbabilityForUpdate ?? row.grouping_probability ?? null,
      groupingExplanation: groupingExplanationTextForResponse,
      groupingExplanationDetails: groupingExplanationDetailsForResponse,
      groupingDebug: groupingDebugForResponse
    })
  };
};


