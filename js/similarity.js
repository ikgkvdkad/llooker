// AI vision-based similarity calculation and visualization

import { analysisState, historyState } from './state.js';
import * as dom from './dom.js';
import { appendDiagnosticMessage } from './analysis-api.js';

const RATIONALE_DEFAULT_PLACEHOLDER = 'No similarity rationale yet. Capture both photos to compare.';
const RATIONALE_DEFAULT_HINT = 'Capture both photos to unlock the AI’s explanation.';
const RATIONALE_READY_HINT = 'AI explanation ready for the latest comparison.';
const RATIONALE_BUTTON_LOADING_LABEL = 'Requesting comparison...';
const RATIONALE_MISSING_PAIR_HINT = 'Capture or select both photos to request a comparison.';

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

function showRationaleHint(message) {
    if (!dom.similarityRationaleHint) {
        return;
    }
    dom.similarityRationaleHint.hidden = false;
    dom.similarityRationaleHint.textContent = message;
}

function updateRationaleHint(hasRationale) {
    if (!dom.similarityRationaleHint) {
        return;
    }
    if (hasRationale) {
        showRationaleHint(RATIONALE_READY_HINT);
        return;
    }
    dom.similarityRationaleHint.hidden = true;
}

function hasRationaleText() {
    return Boolean(normalizeRationaleText(analysisState.similarityRationaleText).length);
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

function buildRationaleList(text) {
    const lines = text
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean);

    if (!lines.length) {
        return null;
    }

    const list = document.createElement('ul');
    list.className = 'similarity-rationale-list';

    for (const rawLine of lines) {
        const item = document.createElement('li');
        let line = rawLine;
        if (line.startsWith('+')) {
            item.classList.add('positive');
            line = line.slice(1).trim();
        } else if (line.startsWith('-')) {
            item.classList.add('negative');
            line = line.slice(1).trim();
        }
        item.textContent = line.length ? line : rawLine;
        list.appendChild(item);
    }

    return list;
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
        const { similarity, confidence, fatal_mismatch: fatalMismatch } = analysisState.lastSimilarityResult;
        const confidenceLabel = confidence ? confidence : 'unknown';
        const fatalLabel = fatalMismatch ? ` • Fatal mismatch: ${fatalMismatch}` : '';
        summary.textContent = `Similarity ${similarity}% • Confidence ${confidenceLabel}${fatalLabel}`;
        dom.similarityRationaleBody.appendChild(summary);
    }

    const list = buildRationaleList(text);
    if (list) {
        dom.similarityRationaleBody.appendChild(list);
        return;
    }

    const fallback = document.createElement('p');
    fallback.className = 'similarity-rationale-empty';
    fallback.textContent = 'Rationale text unavailable. Re-run the comparison.';
    dom.similarityRationaleBody.appendChild(fallback);
}

function setSimilarityRationale(text, placeholderMessage = RATIONALE_DEFAULT_PLACEHOLDER) {
    const normalized = normalizeRationaleText(text);
    analysisState.similarityRationaleText = normalized;
    rationalePlaceholderMessage = placeholderMessage || RATIONALE_DEFAULT_PLACEHOLDER;
    updateRationaleHint(Boolean(normalized));
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
        showRationaleHint(RATIONALE_MISSING_PAIR_HINT);
        return;
    }

    const signature = buildComparisonSignature(youActive, meActive);
    if (!signature) {
        showRationaleHint('Unable to identify the current photo pair. Capture both sides again.');
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
        showRationaleHint('Requesting a fresh comparison...');

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
        showRationaleHint('Similarity match failed. Check diagnostics and try again.');
        return;
    } finally {
        setRationaleButtonLoading(false);
        pendingComparisonSignature = null;
        pendingComparisonPromise = null;
    }

    if (analysisState.lastSimilarityResult?.signature === signature) {
        onRationaleReady?.();
    } else {
        showRationaleHint('Similarity match failed. Check diagnostics and try again.');
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
