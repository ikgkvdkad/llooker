const DEFAULT_VISION_MODEL = 'gpt-4o-mini';

function formatTimeContext(candidate, reference) {
  const time1 = candidate?.capturedAt ? new Date(candidate.capturedAt) : null;
  const time2 = reference?.capturedAt ? new Date(reference.capturedAt) : null;
  if (!(time1 && time2)) {
    return {
      context: 'Time difference unknown.',
      minutes: null
    };
  }

  const diffMinutes = Math.abs(time2 - time1) / (1000 * 60);
  return {
    context: `Photos taken ${Math.round(diffMinutes)} minutes apart.`,
    minutes: diffMinutes
  };
}

function summariseSubject(subject = {}) {
  const gender = subject.gender || 'unknown-gender';
  const ageRange = subject.ageRange || subject.ageBucket || 'unknown-age';
  const build = subject.build || subject.bodyType || 'unknown-build';
  const skinTone = subject.skinTone || 'unknown-skin-tone';
  const hair = subject.hair || {};
  const hairSummary = [
    hair.length || null,
    hair.style || null,
    hair.color || null
  ].filter(Boolean).join('-') || 'unknown-hair';
  const eyewear = subject.eyewear || 'no-eyewear';
  const headwear = subject.headwear || 'no-headwear';
  const distinguishing = Array.isArray(subject.distinguishingFeatures) && subject.distinguishingFeatures.length
    ? subject.distinguishingFeatures.join('; ')
    : 'none';

  return `Gender: ${gender}. Age: ${ageRange}. Build: ${build}. Skin tone: ${skinTone}. Hair: ${hairSummary}. Eyewear: ${eyewear}. Headwear: ${headwear}. Distinguishing features: ${distinguishing}.`;
}

function summariseClothing(clothing = {}, accessories = {}, carriedItems = []) {
  const formatItem = (item = {}) => {
    if (!item || typeof item !== 'object') {
      return 'unknown';
    }
    const parts = [
      item.category || null,
      Array.isArray(item.colors) ? item.colors.join('+') : null,
      item.pattern || null,
      item.style || null
    ].filter(Boolean);
    return parts.length ? parts.join(' | ') : 'unknown';
  };

  const dominantColors = Array.isArray(clothing.dominantColors) && clothing.dominantColors.length
    ? clothing.dominantColors.join(', ')
    : 'unknown';

  const accessoriesSummary = Object.entries(accessories || {})
    .map(([bucket, values]) => Array.isArray(values) && values.length ? `${bucket}: ${values.join(', ')}` : null)
    .filter(Boolean)
    .join(' | ') || 'none';

  const carriedSummary = Array.isArray(carriedItems) && carriedItems.length
    ? carriedItems.join(', ')
    : 'none';

  return [
    `Dominant outfit colours: ${dominantColors}`,
    `Top: ${formatItem(clothing.top)}`,
    `Bottom: ${formatItem(clothing.bottom)}`,
    `Outerwear: ${formatItem(clothing.outerwear)}`,
    `Footwear: ${formatItem(clothing.footwear)}`,
    `Accessories: ${accessoriesSummary}`,
    `Carried items: ${carriedSummary}`
  ].join('\n');
}

function buildComparisonPrompt(candidate, reference) {
  const time = formatTimeContext(candidate, reference);
  const subjectSummary1 = summariseSubject(candidate.analysis?.subject || {});
  const subjectSummary2 = summariseSubject(reference.analysis?.subject || {});
  const outfitSummary1 = summariseClothing(
    candidate.analysis?.clothing,
    candidate.analysis?.accessories,
    candidate.analysis?.carriedItems
  );
  const outfitSummary2 = summariseClothing(
    reference.analysis?.clothing,
    reference.analysis?.accessories,
    reference.analysis?.carriedItems
  );

  const discriminators1 = candidate.discriminators || {};
  const discriminators2 = reference.discriminators || {};

  const prompt = `Compare these two photos to determine if they show the SAME PERSON.

CONTEXT:
${time.context}
Photo 1 subject:
${subjectSummary1}
Photo 1 outfit:
${outfitSummary1}
Photo 1 discriminators: ${JSON.stringify(discriminators1)}

Photo 2 subject:
${subjectSummary2}
Photo 2 outfit:
${outfitSummary2}
Photo 2 discriminators: ${JSON.stringify(discriminators2)}

  Step 0 — Fatal-mismatch check (do this first). If ANY fatal mismatch is present, set probability = 0 and return immediately with an explanation naming the fatal mismatch.

  Fatal mismatches (ONLY these, nothing else):
  - Different major lower-body garment category (skirt/dress vs full-length pants/jeans vs shorts) — but "jeans" and "pants" are the same category.
  - Different major outfit class (dress/one-piece vs separate top+bottom).
  - Clear gender-presentation conflict (male vs female).
  - Clear age-band conflict (child vs adult, or 20s vs 60s — but 50s vs 60s is NOT fatal).

  Do NOT treat as fatal:
  - Removable accessories (hats, bags, scarves) — people can take these off between photos.
  - Footwear description variations ("shoes" vs "sneakers" vs "boots" — these are all footwear).
  - Minor clothing color variations due to lighting ("dark blue" vs "navy" vs "black").
  - Absent mention of a trait in one photo but present in another (only fatal if BOTH explicitly describe it differently).

  TASK:
  Determine the probability (0-100%) that these are photos of the SAME PERSON.

CRITICAL RULES:
  1. Gender mismatch = 0% (fatal).
  2. For photos taken within minutes (time difference < 5 min), allow for removable items (hats, bags) to differ.
  3. Core outfit (top + bottom colors and types) must align for short time windows.
  4. Hair color/length must be compatible (but "black" vs "dark brown" is compatible).
  5. Build, age range, and skin tone must be compatible.
  6. Footwear type variations ("shoes" vs "sneakers") are NOT grounds for rejection if everything else matches.
  7. When photos are taken seconds/minutes apart and all permanent traits match, prefer match over rejection.

COMPARISON PRIORITIES (in order):
1. Gender
2. Outfit colours and layering
3. Hair style/colour
4. Accessories & carried items
5. Build/height category
6. Age range

Return ONLY valid JSON with this exact structure:
  {
    "similarity": <integer 0-100>,
    "confidence": <"high" | "medium" | "low">,
    "reasoning": "Why the score is high OR low, mentioning every major factor that influenced it. Format as sentences separated by \\n, each prefixed with '+' for supporting evidence or '-' for conflicting evidence. Example: \"+ Matching navy blazer and glasses\" or \"- Different footwear and backpack\".",
    "fatal_mismatch": <"gender" | "outfit" | "age" | "hair" | "accessories" | null>
  }

Examples:
  - Identical person: {"similarity": 95, "confidence": "high", "reasoning": "+ Same gender\n+ Matching navy suit and glasses\n+ Identical shoes", "fatal_mismatch": null}
  - Same build but outfit mismatch: {"similarity": 20, "confidence": "high", "reasoning": "+ Similar build\n- Sweater vs bright red jacket\n- Different shoes", "fatal_mismatch": "outfit"}
  - Gender mismatch: {"similarity": 0, "confidence": "high", "reasoning": "- Female vs male presentation\n- Hair length mismatch", "fatal_mismatch": "gender"}`;

  return {
    prompt,
    timeDiffMinutes: time.minutes
  };
}

async function performVisionMatch(openai, candidate, reference, options = {}) {
  if (!candidate?.imageDataUrl || !reference?.imageDataUrl) {
    throw new Error('Both candidate and reference require imageDataUrl for vision comparison.');
  }

  const { prompt, timeDiffMinutes } = buildComparisonPrompt(candidate, reference);
  const model = options.model || DEFAULT_VISION_MODEL;

  const response = await openai.chat.completions.create({
    model,
    messages: [
      {
        role: 'system',
        content: 'You are a re-identification assistant. Compare two cropped person photos and return ONLY valid JSON with similarity, confidence, reasoning, and fatal mismatch.'
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          {
            type: 'image_url',
            image_url: {
              url: candidate.imageDataUrl,
              detail: 'low'
            }
          },
          {
            type: 'image_url',
            image_url: {
              url: reference.imageDataUrl,
              detail: 'low'
            }
          }
        ]
      }
    ],
    response_format: { type: 'json_object' },
    temperature: options.temperature ?? 0.1,
    max_tokens: options.maxTokens ?? 350
  });

  const payload = JSON.parse(response.choices[0].message.content);

  if (typeof payload.similarity !== 'number' || Number.isNaN(payload.similarity)) {
    throw new Error('AI response missing similarity value.');
  }

    return {
      similarity: Math.max(0, Math.min(100, Math.round(payload.similarity))),
      confidence: typeof payload.confidence === 'string' ? payload.confidence : 'medium',
      reasoning: typeof payload.reasoning === 'string' ? payload.reasoning : 'No reasoning provided',
      fatal_mismatch: typeof payload.fatal_mismatch === 'string' ? payload.fatal_mismatch : null,
      timeDiffMinutes: timeDiffMinutes !== null ? Math.round(timeDiffMinutes) : null
    };
}

module.exports = {
  DEFAULT_VISION_MODEL,
  performVisionMatch,
  buildComparisonPrompt,
  summariseSubject,
  summariseClothing
};
