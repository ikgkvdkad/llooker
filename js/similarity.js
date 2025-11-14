// AI vision-based similarity calculation and visualization

import { analysisState, historyState } from './state.js';
import * as dom from './dom.js';
import { appendDiagnosticMessage } from './analysis-api.js';
import { showWarning } from './ui.js';

const RATIONALE_DEFAULT_PLACEHOLDER = 'No similarity rationale yet. Capture both photos to compare.';
const RATIONALE_BUTTON_LOADING_LABEL = 'Requesting comparison...';
const RATIONALE_MISSING_PAIR_MESSAGE = 'Capture or select both photos to request a comparison.';
const RATIONALE_SIGNATURE_ERROR_MESSAGE = 'Unable to identify the current photo pair. Capture both sides again.';
const RATIONALE_FAILURE_MESSAGE = 'Similarity match failed. Check diagnostics and try again.';

let rationalePlaceholderMessage = RATIONALE_DEFAULT_PLACEHOLDER;
let rationaleButtonDefaultLabel = null;
let pendingComparisonSignature = null;
let pendingComparisonPromise = null;

function normalizeRationaleText(text) {
    if (typeof text !== 'string') {
        return '';
    }
    return text.trim();
}

function getRationaleButtonDefaultLabel() {
    if (rationaleButtonDefaultLabel) {
        return rationaleButtonDefaultLabel;
    }
    if (!dom.similarityRationaleButton) {
        rationaleButtonDefaultLabel = 'View similarity rationale';
        return rationaleButtonDefaultLabel;
    }
    const text = dom.similarityRationaleButton.textContent
        ? dom.similarityRationaleButton.textContent.replace(/\s+/g, ' ').trim()
        : '';
    rationaleButtonDefaultLabel = text || 'View similarity rationale';
    return rationaleButtonDefaultLabel;
}

function setRationaleButtonLoading(isLoading) {
    if (!dom.similarityRationaleButton) {
        return;
    }
    const label = getRationaleButtonDefaultLabel();
    dom.similarityRationaleButton.textContent = isLoading ? RATIONALE_BUTTON_LOADING_LABEL : label;
    dom.similarityRationaleButton.classList.toggle('is-loading', Boolean(isLoading));
    dom.similarityRationaleButton.disabled = Boolean(isLoading);
    dom.similarityRationaleButton.setAttribute('aria-busy', isLoading ? 'true' : 'false');
}

function getLiveSideData(side) {
    const state = analysisState[side];
    if (!state) {
        return null;
    }
    return {
        source: 'live',
        id: state.capturedAt ? `live:${state.capturedAt}` : null,
        imageDataUrl: state.imageDataUrl || null,
        analysis: state.analysis || null,
        discriminators: state.discriminators || null,
        capturedAt: state.capturedAt || null
    };
}

function getHistoryEntry(side) {
    const history = historyState?.[side];
    if (!history || typeof history.currentIndex !== 'number' || history.currentIndex < 0) {
        return null;
    }
    return history.analyses?.[history.currentIndex] || null;
}

function getActiveSideData(side) {
    const historyEntry = getHistoryEntry(side);
    if (historyEntry) {
        return {
            source: 'history',
            id: historyEntry.id ?? historyEntry.capturedAt ?? historyEntry.createdAt ?? null,
            imageDataUrl: historyEntry.imageDataUrl || null,
            analysis: historyEntry.analysis || null,
            discriminators: historyEntry.discriminators || null,
            capturedAt: historyEntry.capturedAt || historyEntry.createdAt || null
        };
    }
    return getLiveSideData(side);
}

function buildSideSignature(data, label) {
    if (!data || !data.imageDataUrl) {
        return null;
    }
    if (data.id) {
        return `${label}:id:${data.id}`;
    }
    if (data.capturedAt) {
        return `${label}:captured:${data.capturedAt}`;
    }
    return `${label}:data:${data.imageDataUrl.slice(0, 64)}`;
}

function buildComparisonSignature(youData, meData) {
    const youSignature = buildSideSignature(youData, 'you');
    const meSignature = buildSideSignature(meData, 'me');
    if (!youSignature || !meSignature) {
        return null;
    }
    return `${youSignature}__${meSignature}`;
}

function normalizeComparisonData(side, overrideData) {
    if (overrideData) {
        return {
            source: overrideData.source || 'custom',
            id: overrideData.id ?? null,
            imageDataUrl: overrideData.imageDataUrl || null,
            analysis: overrideData.analysis || null,
            discriminators: overrideData.discriminators || null,
            capturedAt: overrideData.capturedAt || null
        };
    }
    return getLiveSideData(side);
}

function formatEvidenceList(items) {
    if (!Array.isArray(items) || !items.length) {
        return '';
    }
    if (items.length === 1) {
        return items[0];
    }
    if (items.length === 2) {
        return `${items[0]} and ${items[1]}`;
    }
    const head = items.slice(0, -1).join(', ');
    const tail = items[items.length - 1];
    return `${head}, and ${tail}`;
}

function chunkSentences(sentences, perParagraph = 2) {
    if (!Array.isArray(sentences) || !sentences.length) {
        return [];
    }
    const chunks = [];
    for (let i = 0; i < sentences.length; i += perParagraph) {
        chunks.push(sentences.slice(i, i + perParagraph).join(' '));
    }
    return chunks;
}

function buildExplanationParagraphs(text) {
    const lines = text
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean);

    if (!lines.length) {
        return [];
    }

    const evidence = {
        positive: [],
        negative: [],
        neutral: []
    };

    for (const rawLine of lines) {
        if (rawLine.startsWith('+')) {
            const cleaned = rawLine.slice(1).trim() || rawLine;
            evidence.positive.push(cleaned);
        } else if (rawLine.startsWith('-')) {
            const cleaned = rawLine.slice(1).trim() || rawLine;
            evidence.negative.push(cleaned);
        } else {
            evidence.neutral.push(rawLine);
        }
    }

    const sentences = [];
    if (evidence.positive.length) {
        sentences.push(`Supporting cues (${evidence.positive.length}) include ${formatEvidenceList(evidence.positive)}.`);
    }
    if (evidence.negative.length) {
        sentences.push(`Conflicts (${evidence.negative.length}) include ${formatEvidenceList(evidence.negative)}.`);
    }
    if (evidence.neutral.length) {
        sentences.push(`Additional context noted: ${formatEvidenceList(evidence.neutral)}.`);
    }

    return chunkSentences(sentences, 2);
}

function createSection(title, paragraphs) {
    if (!Array.isArray(paragraphs) || !paragraphs.length) {
        return null;
    }
    const section = document.createElement('section');
    section.className = 'similarity-rationale-section';
    const heading = document.createElement('h3');
    heading.textContent = title;
    section.appendChild(heading);
    for (const text of paragraphs) {
        if (!text) {
            continue;
        }
        const paragraph = document.createElement('p');
        paragraph.className = 'similarity-rationale-paragraph';
        paragraph.textContent = text;
        section.appendChild(paragraph);
    }
    return section;
}

function formatHairSummary(hair) {
    if (!hair || typeof hair !== 'object') {
        return null;
    }
    const parts = [hair.length, hair.style, hair.color]
        .map(value => (typeof value === 'string' ? value.trim() : ''))
        .filter(Boolean);
    return parts.length ? parts.join(' ') : null;
}

function normalizeAttributeValue(value) {
    if (value === null || value === undefined) {
        return null;
    }
    if (typeof value === 'string') {
        const trimmed = value.trim();
        return trimmed.length ? trimmed : null;
    }
    if (Array.isArray(value)) {
        const normalized = value
            .map(entry => normalizeAttributeValue(entry))
            .filter(Boolean);
        return normalized.length ? normalized.join(', ') : null;
    }
    if (typeof value === 'object') {
        const normalized = Object.values(value)
            .map(entry => normalizeAttributeValue(entry))
            .filter(Boolean);
        return normalized.length ? normalized.join(' ') : null;
    }
    return String(value);
}

function compareAttributeSentence(label, youValueRaw, meValueRaw) {
    const youValue = normalizeAttributeValue(youValueRaw);
    const meValue = normalizeAttributeValue(meValueRaw);
    if (!youValue && !meValue) {
        return null;
    }
    if (youValue && meValue && youValue.toLowerCase && meValue.toLowerCase) {
        if (youValue.toLowerCase() === meValue.toLowerCase()) {
            return `${label} aligns (${youValue}).`;
        }
    }
    if (!youValue || !meValue) {
        return `${label} data is incomplete (You: ${youValue || 'unknown'}, Me: ${meValue || 'unknown'}).`;
    }
    return `${label} differs — You: ${youValue}; Me: ${meValue}.`;
}

function buildFacialComparisonSection() {
    const youSubject = analysisState.you.analysis?.subject || null;
    const meSubject = analysisState.me.analysis?.subject || null;
    if (!youSubject && !meSubject) {
        return null;
    }

    const sentences = [
        compareAttributeSentence('Gender presentation', youSubject?.gender, meSubject?.gender),
        compareAttributeSentence('Age range', youSubject?.ageRange || youSubject?.ageBucket, meSubject?.ageRange || meSubject?.ageBucket),
        compareAttributeSentence('Skin tone', youSubject?.skinTone, meSubject?.skinTone),
        compareAttributeSentence('Hair style', formatHairSummary(youSubject?.hair), formatHairSummary(meSubject?.hair)),
        compareAttributeSentence('Facial hair', youSubject?.facialHair, meSubject?.facialHair),
        compareAttributeSentence('Eyewear', youSubject?.eyewear, meSubject?.eyewear),
        compareAttributeSentence('Headwear', youSubject?.headwear, meSubject?.headwear)
    ].filter(Boolean);

    if (!sentences.length) {
        return createSection('Facial comparison', ['No facial attributes available from the latest analyses.']);
    }

    const paragraphs = chunkSentences(sentences, 3);
    return createSection('Facial comparison', paragraphs);
}

function formatTimestamp(value) {
    if (!value) {
        return null;
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return null;
    }
    return date.toLocaleString();
}

function formatCaptureInfo(label, sideState) {
    if (!sideState) {
        return null;
    }
    const timestamp = formatTimestamp(sideState.capturedAt);
    if (timestamp) {
        return `${label} photo captured ${timestamp}.`;
    }
    return `${label} capture time unknown.`;
}

function formatDiscriminatorSummary(label, discriminators) {
    if (!discriminators || typeof discriminators !== 'object') {
        return `${label} discriminators unavailable.`;
    }
    const entries = Object.entries(discriminators)
        .filter(([, value]) => value !== null && value !== undefined && `${value}`.length > 0)
        .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : value}`);
    if (!entries.length) {
        return `${label} discriminators unavailable.`;
    }
    return `${label} discriminators considered: ${entries.join(' | ')}.`;
}

function buildRecognitionSection() {
    const result = analysisState.lastSimilarityResult;
    if (!result) {
        return null;
    }

    const paragraphs = [];
    const fatalText = result.fatal_mismatch
        ? `Fatal mismatch flagged (${result.fatal_mismatch}).`
        : 'No fatal mismatch detected.';
    const timeGap = typeof result.timeDiffMinutes === 'number'
        ? `Photos captured approximately ${Math.round(result.timeDiffMinutes)} minutes apart.`
        : 'Time gap between captures is unknown.';
    paragraphs.push(`Model confidence reported as ${result.confidence || 'unknown'} for the ${result.similarity}% similarity score. ${fatalText} ${timeGap}`);

    const captureDetails = [
        formatCaptureInfo('You', analysisState.you),
        formatCaptureInfo('Me', analysisState.me)
    ].filter(Boolean);
    if (captureDetails.length) {
        paragraphs.push(captureDetails.join(' '));
    }

    const discriminatorDetails = [
        formatDiscriminatorSummary('You', analysisState.you.discriminators),
        formatDiscriminatorSummary('Me', analysisState.me.discriminators)
    ].filter(Boolean);
    if (discriminatorDetails.length) {
        paragraphs.push(discriminatorDetails.join(' '));
    }

    return createSection('Recognition info', paragraphs);
}

function buildExplanationSection(text) {
    const normalized = typeof text === 'string' ? text.trim() : '';
    if (!normalized.length) {
        return null;
    }
    const paragraphs = buildExplanationParagraphs(normalized);
    if (!paragraphs.length) {
        return createSection('AI rationale', [normalized]);
    }
    return createSection('AI rationale', paragraphs);
}

function renderSimilarityRationaleBody() {
    if (!dom.similarityRationaleBody) {
        return;
    }

    dom.similarityRationaleBody.innerHTML = '';

    const text = analysisState.similarityRationaleText;
    const hasText = Boolean(text && text.length);

    if (!hasText) {
        const empty = document.createElement('p');
        empty.className = 'similarity-rationale-empty';
        empty.textContent = rationalePlaceholderMessage;
        dom.similarityRationaleBody.appendChild(empty);
        return;
    }

    if (analysisState.lastSimilarityResult) {
        const summary = document.createElement('p');
        summary.className = 'similarity-rationale-summary';
        const {
            similarity,
            confidence,
            fatal_mismatch: fatalMismatch,
            timeDiffMinutes
        } = analysisState.lastSimilarityResult;
        const confidenceLabel = confidence || 'unknown';
        const fatalLabel = fatalMismatch ? `Fatal mismatch: ${fatalMismatch}` : 'No fatal mismatch detected';
        const timeDiffLabel = typeof timeDiffMinutes === 'number'
            ? `Time gap ${Math.round(timeDiffMinutes)} min`
            : 'Time gap unknown';
        summary.textContent = `Similarity ${similarity}% • Confidence ${confidenceLabel} • ${fatalLabel} • ${timeDiffLabel}`;
        dom.similarityRationaleBody.appendChild(summary);
    }

    let appendedContent = false;

    const explanationSection = buildExplanationSection(text);
    if (explanationSection) {
        dom.similarityRationaleBody.appendChild(explanationSection);
        appendedContent = true;
    }

    const facialSection = buildFacialComparisonSection();
    if (facialSection) {
        dom.similarityRationaleBody.appendChild(facialSection);
        appendedContent = true;
    }

    const recognitionSection = buildRecognitionSection();
    if (recognitionSection) {
        dom.similarityRationaleBody.appendChild(recognitionSection);
        appendedContent = true;
    }

    if (!appendedContent) {
        const fallback = document.createElement('p');
        fallback.className = 'similarity-rationale-empty';
        fallback.textContent = 'Rationale text unavailable. Re-run the comparison.';
        dom.similarityRationaleBody.appendChild(fallback);
    }
}

function setSimilarityRationale(text, placeholderMessage = RATIONALE_DEFAULT_PLACEHOLDER) {
    const normalized = normalizeRationaleText(text);
    analysisState.similarityRationaleText = normalized;
    rationalePlaceholderMessage = placeholderMessage || RATIONALE_DEFAULT_PLACEHOLDER;
    renderSimilarityRationaleBody();
}

setSimilarityRationale('', RATIONALE_DEFAULT_PLACEHOLDER);

/**
 * Store photo data for a side and trigger similarity check
 */
export function storePhotoData(side, imageDataUrl, analysis = null, capturedAt = null, discriminators = null) {
    if (!imageDataUrl || typeof imageDataUrl !== 'string') {
        console.warn(`Invalid imageDataUrl for ${side}`);
        return;
    }

    const state = analysisState[side];
    if (!state) {
        console.warn(`Invalid side: ${side}`);
        return;
    }

    state.imageDataUrl = imageDataUrl;
    state.analysis = analysis;
    state.discriminators = discriminators;
    state.capturedAt = capturedAt;
    
    console.log(`Stored photo data for ${side}:`, {
        hasImage: !!imageDataUrl,
        gender: analysis?.subject?.gender,
        ageRange: analysis?.subject?.ageRange || analysis?.subject?.ageBucket,
        capturedAt: capturedAt
    });

    // Trigger similarity check if both photos ready
    updateSimilarityBar();
}

/**
 * Update similarity bar using AI vision comparison
 */
export async function updateSimilarityBar(options = {}) {
    const youData = normalizeComparisonData('you', options.youData);
    const meData = normalizeComparisonData('me', options.meData);
    const comparisonSignature = options.signature ?? buildComparisonSignature(youData, meData);
    const triggerSource = options.triggerSource || 'auto';
    const shouldPropagateError = options.propagateErrors === true;

    // Check if both photos are ready
    if (!youData?.imageDataUrl || !meData?.imageDataUrl) {
        if (dom.similarityBarFill) {
            dom.similarityBarFill.style.height = '0%';
        }
        if (dom.similarityPercentage) {
            dom.similarityPercentage.textContent = '-';
        }
        analysisState.lastSimilarityResult = null;
        setSimilarityRationale('', RATIONALE_DEFAULT_PLACEHOLDER);
        return;
    }

    if (dom.similarityPercentage) {
        dom.similarityPercentage.textContent = '...';
    }

    console.log('=== REQUESTING AI VISION MATCH ===', { trigger: triggerSource, signature: comparisonSignature });
    console.log('You:', {
        source: youData.source,
        gender: youData.analysis?.subject?.gender,
        age: youData.analysis?.subject?.ageRange || youData.analysis?.subject?.ageBucket,
        capturedAt: youData.capturedAt
    });
    console.log('Me:', {
        source: meData.source,
        gender: meData.analysis?.subject?.gender,
        age: meData.analysis?.subject?.ageRange || meData.analysis?.subject?.ageBucket,
        capturedAt: meData.capturedAt
    });

    try {
        const response = await fetch('/.netlify/functions/ai-vision-match', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                photo1: {
                    imageDataUrl: youData.imageDataUrl,
                    analysis: youData.analysis,
                    discriminators: youData.discriminators,
                    capturedAt: youData.capturedAt
                },
                photo2: {
                    imageDataUrl: meData.imageDataUrl,
                    analysis: meData.analysis,
                    discriminators: meData.discriminators,
                    capturedAt: meData.capturedAt
                }
            })
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.error || `HTTP ${response.status}`);
        }

        const result = await response.json();

        console.log('=== AI VISION MATCH RESULT ===');
        console.log('Similarity:', result.similarity + '%');
        console.log('Confidence:', result.confidence);
        console.log('Reasoning:', result.reasoning);
        console.log('Fatal mismatch:', result.fatal_mismatch || 'none');
        console.log('Time difference:', result.timeDiffMinutes ? `${result.timeDiffMinutes} min` : 'unknown');

        const percentage = Math.max(0, Math.min(100, result.similarity));

        if (dom.similarityBarFill) {
            dom.similarityBarFill.style.height = `${percentage}%`;
        }

        if (dom.similarityPercentage) {
            dom.similarityPercentage.textContent = `${percentage}%`;
        }

        analysisState.lastSimilarityResult = {
            similarity: percentage,
            confidence: result.confidence,
            reasoning: result.reasoning,
            fatal_mismatch: result.fatal_mismatch,
            timeDiffMinutes: typeof result.timeDiffMinutes === 'number' ? result.timeDiffMinutes : null,
            timestamp: new Date().toISOString(),
            signature: comparisonSignature || null,
            context: {
                you: {
                    source: youData.source || 'live',
                    capturedAt: youData.capturedAt || null,
                    id: youData.id || null
                },
                me: {
                    source: meData.source || 'live',
                    capturedAt: meData.capturedAt || null,
                    id: meData.id || null
                }
            }
        };
        setSimilarityRationale(result.reasoning);
    } catch (error) {
        console.error('AI vision matching failed:', error);

        if (dom.similarityPercentage) {
            dom.similarityPercentage.textContent = 'ERR';
        }

        analysisState.lastSimilarityResult = null;
        analysisState.lastSimilarityError = {
            message: error.message,
            timestamp: new Date().toISOString()
        };
        setSimilarityRationale('', 'Similarity match failed. Check diagnostics and try again.');

        const diagnosticMessage = `Similarity match failed: ${error?.message || 'Unknown error.'}`;
        const diagnosticDetail = error?.stack || error?.message || null;
        appendDiagnosticMessage('you', diagnosticMessage, { level: 'error', detail: diagnosticDetail });
        appendDiagnosticMessage('me', diagnosticMessage, { level: 'error', detail: diagnosticDetail });
        if (shouldPropagateError) {
            throw error;
        }
    }
}

export async function handleSimilarityRationaleRequest(options = {}) {
    const { onRationaleReady } = options;
    const youActive = getActiveSideData('you');
    const meActive = getActiveSideData('me');

    if (!youActive?.imageDataUrl || !meActive?.imageDataUrl) {
        showWarning(RATIONALE_MISSING_PAIR_MESSAGE, { sides: ['you', 'me'] });
        return;
    }

    const signature = buildComparisonSignature(youActive, meActive);
    if (!signature) {
        showWarning(RATIONALE_SIGNATURE_ERROR_MESSAGE, { sides: ['you', 'me'] });
        return;
    }

    const existingResult = analysisState.lastSimilarityResult;
    if (existingResult?.signature === signature) {
        if (typeof onRationaleReady === 'function') {
            onRationaleReady();
        }
        return;
    }

    if (pendingComparisonPromise) {
        if (pendingComparisonSignature === signature) {
            try {
                await pendingComparisonPromise;
            } catch (error) {
                console.error('Similarity comparison already in progress failed:', error);
                return;
            }
            if (analysisState.lastSimilarityResult?.signature === signature) {
                onRationaleReady?.();
            }
            return;
        }
        try {
            await pendingComparisonPromise;
        } catch (error) {
            console.error('Previous similarity comparison failed:', error);
        }
    }

    try {
        pendingComparisonSignature = signature;
        setRationaleButtonLoading(true);

        pendingComparisonPromise = updateSimilarityBar({
            youData: youActive,
            meData: meActive,
            signature,
            triggerSource: 'manual-button',
            propagateErrors: true
        });

        await pendingComparisonPromise;
    } catch (error) {
        console.error('Manual similarity comparison failed:', error);
        showWarning(RATIONALE_FAILURE_MESSAGE, { sides: ['you', 'me'] });
        return;
    } finally {
        setRationaleButtonLoading(false);
        pendingComparisonSignature = null;
        pendingComparisonPromise = null;
    }

    if (analysisState.lastSimilarityResult?.signature === signature) {
        onRationaleReady?.();
    } else {
        showWarning(RATIONALE_FAILURE_MESSAGE, { sides: ['you', 'me'] });
    }
}

/**
 * Clear photo data for a side
 */
export function clearPhotoData(side) {
    const state = analysisState[side];
    if (!state) return;

    state.imageDataUrl = null;
    state.analysis = null;
    state.discriminators = null;
    state.capturedAt = null;
    updateSimilarityBar();
}

/**
 * Clear all photo data
 */
export function clearAllPhotoData() {
    analysisState.you.imageDataUrl = null;
    analysisState.you.analysis = null;
    analysisState.you.discriminators = null;
    analysisState.you.capturedAt = null;
    analysisState.me.imageDataUrl = null;
    analysisState.me.analysis = null;
    analysisState.me.discriminators = null;
    analysisState.me.capturedAt = null;
    analysisState.lastSimilarityResult = null;
    analysisState.lastSimilarityError = null;
    pendingComparisonSignature = null;
    pendingComparisonPromise = null;
    setRationaleButtonLoading(false);
    setSimilarityRationale('', RATIONALE_DEFAULT_PLACEHOLDER);
    
    updateSimilarityBar();
}
