// AI analysis API communication

import {
    WAITING_FOR_ANALYSIS_MESSAGE,
    ANALYSIS_API_TIMEOUT_MS,
    ANALYSIS_MOVEMENT_DEBOUNCE_MS,
    ANALYSIS_API_URL
} from './config.js';
import {
    photoSlots,
    interactionState,
    analysisState,
    analysisQueue,
    setAnalysisInFlight,
    getAnalysisInFlight
} from './state.js';
import { getPhotoSlotByAnalysisSide, clampRectToBounds, loadImageElement } from './utils.js';
import { snapshotViewportState, clearMovementDebounce } from './zoom.js';
import { showWarning } from './ui.js';
import { addToHistory } from './history.js';
import { storePhotoData } from './similarity.js';
import { extractGpsLocationFromDataUrl } from './exif.js';

const missingGpsWarningShown = new Set();
let analysisEnabled = true;

export function setAnalysisEnabled(enabled) {
    analysisEnabled = Boolean(enabled);
}

const DEBUG_METADATA_TIMING = Boolean(
    typeof window !== 'undefined' && window.__DEBUG_METADATA_TIMING__
);

function now() {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
        return performance.now();
    }
    return Date.now();
}

function logTiming(label, durationMs, outcome = 'ok') {
    if (!DEBUG_METADATA_TIMING) {
        return;
    }
    const suffix = outcome === 'ok' ? '' : ` (${outcome})`;
    console.log(`[analysis-timing] ${label}: ${durationMs.toFixed(2)}ms${suffix}`);
}

function runWithTiming(label, fn) {
    if (!DEBUG_METADATA_TIMING) {
        return fn();
    }
    const start = now();
    try {
        const result = fn();
        if (result && typeof result.then === 'function') {
            return result.then(
                (value) => {
                    logTiming(label, now() - start);
                    return value;
                },
                (error) => {
                    logTiming(label, now() - start, 'error');
                    throw error;
                }
            );
        }
        logTiming(label, now() - start);
        return result;
    } catch (error) {
        logTiming(label, now() - start, 'error');
        throw error;
    }
}

const MAX_DIAGNOSTIC_ENTRIES = 12;

function truncateText(value, maxLength) {
    if (typeof value !== 'string') {
        return '';
    }
    if (value.length <= maxLength) {
        return value;
    }
    return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function sanitizeDiagnosticLevel(level) {
    if (typeof level !== 'string') {
        return 'INFO';
    }
    const normalized = level.trim().toLowerCase();
    if (!normalized.length) {
        return 'INFO';
    }
    if (normalized === 'error' || normalized === 'warning' || normalized === 'info') {
        return normalized.toUpperCase();
    }
    return normalized.slice(0, 1).toUpperCase() + normalized.slice(1, 5).toLowerCase();
}

function normalizeDiagnosticDetail(detail) {
    if (typeof detail === 'string') {
        const trimmed = detail.trim();
        return trimmed.length ? truncateText(trimmed, 600) : null;
    }

    if (Array.isArray(detail)) {
        const joined = detail
            .map(item => (typeof item === 'string' ? item.trim() : ''))
            .filter(Boolean)
            .join(' | ');
        return joined.length ? truncateText(joined, 600) : null;
    }

    if (detail && typeof detail === 'object') {
        try {
            const json = JSON.stringify(detail);
            return json.length ? truncateText(json, 600) : null;
        } catch {
            return null;
        }
    }

    return null;
}

function formatDiagnosticTimestamp(timestamp) {
    if (timestamp instanceof Date && !Number.isNaN(timestamp.getTime())) {
        return timestamp.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }

    if (typeof timestamp === 'number' && Number.isFinite(timestamp)) {
        const asDate = new Date(timestamp);
        if (!Number.isNaN(asDate.getTime())) {
            return asDate.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
        }
    }

    if (typeof timestamp === 'string' && timestamp.trim().length) {
        return timestamp.trim();
    }

    return null;
}

function formatDiagnosticEntry(entry) {
    if (!entry) {
        return '';
    }

    if (typeof entry === 'string') {
        return entry.trim();
    }

    if (typeof entry.message !== 'string' || !entry.message.trim().length) {
        return '';
    }

    const timestampLabel = formatDiagnosticTimestamp(entry.timestamp);
    const level = typeof entry.level === 'string' && entry.level.trim().length
        ? entry.level.trim().toUpperCase()
        : null;

    const labels = [];
    if (timestampLabel) {
        labels.push(timestampLabel);
    }
    if (level) {
        labels.push(level);
    }

    const prefix = labels.length ? `[${labels.join(' ')}] ` : '';
    const baseMessage = `${prefix}${entry.message.trim()}`;
    const detail = typeof entry.detail === 'string' && entry.detail.trim().length
        ? entry.detail.trim()
        : '';

    if (!detail.length) {
        return baseMessage;
    }

    return `${baseMessage}\n   ↳ ${detail}`;
}

function refreshAnalysisContent(side) {
    const state = analysisState[side];
    if (!state || !state.contentEl) {
        return;
    }

    const parts = [];
    const summary = typeof state.analysisText === 'string' ? state.analysisText.trim() : '';
    if (summary.length) {
        parts.push(summary);
    }

    const diagnostics = Array.isArray(state.diagnostics) ? state.diagnostics : [];
    const formattedDiagnostics = diagnostics
        .map(formatDiagnosticEntry)
        .filter(line => line.length > 0);

    if (formattedDiagnostics.length) {
        parts.push('[Diagnostics]', formattedDiagnostics.join('\n'));
    }

    state.contentEl.textContent = parts.join('\n\n');
}

export function appendDiagnosticMessage(side, message, options = {}) {
    if (!analysisEnabled) {
        return;
    }
    const state = analysisState[side];
    if (!state) {
        return;
    }

    const normalizedMessage = typeof message === 'string' ? message.trim() : '';
    if (!normalizedMessage.length) {
        return;
    }

    if (!Array.isArray(state.diagnostics)) {
        state.diagnostics = [];
    }

    const entry = {
        message: truncateText(normalizedMessage, 400),
        detail: normalizeDiagnosticDetail(options.detail ?? null),
        level: sanitizeDiagnosticLevel(options.level ?? options.type ?? 'info'),
        timestamp: options.timestamp ?? new Date()
    };

    state.diagnostics.push(entry);

    if (state.diagnostics.length > MAX_DIAGNOSTIC_ENTRIES) {
        state.diagnostics.splice(0, state.diagnostics.length - MAX_DIAGNOSTIC_ENTRIES);
    }

    refreshAnalysisContent(side);
}

/**
 * Reset analysis state for a side
 */
export function resetAnalysisState(side) {
    if (!analysisEnabled) {
        return;
    }
    const state = analysisState[side];
    if (!state) return;
    state.panel.classList.remove('loading', 'error', 'success');
    state.statusEl.textContent = side === 'you'
        ? 'Waiting for a You capture. Capture or upload a photo, then pan and zoom to frame the subject.'
        : 'Waiting for a Me capture. Capture or upload your selfie, then center yourself in the frame.';
    state.analysisText = '';
    state.diagnostics = [];
    refreshAnalysisContent(side);
    state.analysis = null;
    state.imageDataUrl = null;
    state.discriminators = null;
    state.capturedAt = null;
}

/**
 * Set analysis state for a side
 */
export function setAnalysisState(side, status, message, analysisText = '') {
    if (!analysisEnabled) {
        return;
    }
    const state = analysisState[side];
    if (!state) return;
    state.panel.classList.remove('loading', 'error', 'success');
    if (status === 'loading') {
        state.panel.classList.add('loading');
    } else if (status === 'error') {
        state.panel.classList.add('error');
    } else if (status === 'success') {
        state.panel.classList.add('success');
    }
    if (typeof message === 'string') {
        state.statusEl.textContent = message;
    }
    state.analysisText = typeof analysisText === 'string' ? analysisText : '';
    refreshAnalysisContent(side);
}

/**
 * Build viewport signature for deduplication
 */
export function buildViewportSignature(photoDataUrl, viewportSnapshot) {
    if (typeof photoDataUrl !== 'string' || !photoDataUrl.length || !viewportSnapshot) {
        return null;
    }
    const { containerWidth, containerHeight, naturalWidth, naturalHeight, transform, selection } = viewportSnapshot;
    const parts = [
        containerWidth && Number.isFinite(containerWidth) ? containerWidth.toFixed(1) : 'cw',
        containerHeight && Number.isFinite(containerHeight) ? containerHeight.toFixed(1) : 'ch',
        naturalWidth && Number.isFinite(naturalWidth) ? naturalWidth.toFixed(1) : 'nw',
        naturalHeight && Number.isFinite(naturalHeight) ? naturalHeight.toFixed(1) : 'nh',
        transform && Number.isFinite(transform.scale) ? transform.scale.toFixed(3) : 's',
        transform && Number.isFinite(transform.translateX) ? transform.translateX.toFixed(1) : 'tx',
        transform && Number.isFinite(transform.translateY) ? transform.translateY.toFixed(1) : 'ty'
    ];
    if (selection) {
        parts.push(
            Number.isFinite(selection.x) ? selection.x.toFixed(4) : 'sx',
            Number.isFinite(selection.y) ? selection.y.toFixed(4) : 'sy',
            Number.isFinite(selection.width) ? selection.width.toFixed(4) : 'sw',
            Number.isFinite(selection.height) ? selection.height.toFixed(4) : 'sh'
        );
    } else {
        parts.push('sx', 'sy', 'sw', 'sh');
    }
    const prefix = photoDataUrl.length > 64 ? photoDataUrl.slice(0, 64) : photoDataUrl;
    return `${prefix}|${parts.join('|')}`;
}

/**
 * Submit viewport analysis
 */
export function submitViewportAnalysis(slotKey, { force = false, reason = 'interaction' } = {}) {
    if (!analysisEnabled) {
        return;
    }
    const slot = photoSlots[slotKey];
    const state = interactionState[slotKey];
    if (!slot || !state) {
        return;
    }

    const photoDataUrl = slot.lastPhotoDataUrl;
    if (typeof photoDataUrl !== 'string' || !photoDataUrl.length) {
        return;
    }

    const side = slotKey === 'back' ? 'you' : 'me';
    const viewport = snapshotViewportState(slotKey);
    if (!viewport) {
        return;
    }

    const signature = buildViewportSignature(photoDataUrl, viewport);
    if (!force && signature && state.lastSubmittedSignature === signature) {
        return;
    }

    state.lastSubmittedSignature = signature;
    const label = side === 'you' ? 'You' : 'Me';
    setAnalysisState(side, 'loading', WAITING_FOR_ANALYSIS_MESSAGE, WAITING_FOR_ANALYSIS_MESSAGE);
    enqueueAnalysis(side, photoDataUrl, viewport, {
        reason,
        signature,
        capturedAt: new Date().toISOString()
    });
}

/**
 * Schedule viewport analysis
 */
export function scheduleViewportAnalysis(slotKey, options = {}) {
    if (!analysisEnabled) {
        return;
    }
    const state = interactionState[slotKey];
    if (!state) {
        return;
    }
    clearMovementDebounce(slotKey);
    const delay = options.immediate ? 0 : ANALYSIS_MOVEMENT_DEBOUNCE_MS;
    state.movementDebounceId = window.setTimeout(() => {
        state.movementDebounceId = null;
        submitViewportAnalysis(slotKey, {
            force: options.force === true,
            reason: options.reason || 'interaction'
        });
    }, delay);
}

/**
 * Handle re-analyze request
 */
export function handleReanalyze(side) {
    if (!analysisEnabled) {
        return;
    }
    const slot = getPhotoSlotByAnalysisSide(side);
    const label = side === 'you' ? 'You' : 'Me';

    if (!slot) {
        console.warn(`No photo slot available for ${side} re-analysis request.`);
        return;
    }

    const photoDataUrl = slot.lastPhotoDataUrl;
    const hasActivePhoto = !!(slot.imageEl && slot.imageEl.classList.contains('active'));

    if (!photoDataUrl) {
        const message = hasActivePhoto
            ? `${label} photo data is still loading. Try again shortly or capture a new photo.`
            : `${label} photo not captured yet. Capture a photo before requesting analysis.`;
        setAnalysisState(side, 'error', message);
        return;
    }

    const slotKey = side === 'you' ? 'back' : 'selfie';
    const interaction = interactionState[slotKey];
    if (interaction) {
        interaction.lastSubmittedSignature = null;
        clearMovementDebounce(slotKey);
    }

    const submit = () => submitViewportAnalysis(slotKey, { force: true, reason: 'reanalyze' });

    if (slot.imageEl && slot.imageEl.complete && slot.imageEl.naturalWidth > 0) {
        submit();
    } else if (slot.imageEl) {
        const handleLoad = () => {
            slot.imageEl.removeEventListener('load', handleLoad);
            submit();
        };
        slot.imageEl.addEventListener('load', handleLoad, { once: true });
    } else {
        submit();
    }
}

/**
 * Create viewport data URL
 */
export async function createViewportDataUrl(photoDataUrl, viewportSnapshot) {
    if (typeof photoDataUrl !== 'string' || photoDataUrl.length === 0) {
        throw new Error('Photo data unavailable.');
    }

    const image = await loadImageElement(photoDataUrl);
    const naturalWidth = image.naturalWidth || image.width;
    const naturalHeight = image.naturalHeight || image.height;

    if (!naturalWidth || !naturalHeight) {
        throw new Error('Photo dimensions unavailable.');
    }

    if (
        !viewportSnapshot ||
        !Number.isFinite(viewportSnapshot.containerWidth) ||
        !Number.isFinite(viewportSnapshot.containerHeight) ||
        viewportSnapshot.containerWidth <= 0 ||
        viewportSnapshot.containerHeight <= 0
    ) {
        const error = new Error('Viewport geometry missing.');
        error.name = 'ViewportNotReadyError';
        throw error;
    }

    const containerWidth = viewportSnapshot.containerWidth;
    const containerHeight = viewportSnapshot.containerHeight;
    const selectionInput = viewportSnapshot.selection;

    if (
        !selectionInput ||
        !Number.isFinite(selectionInput.x) ||
        !Number.isFinite(selectionInput.y) ||
        !Number.isFinite(selectionInput.width) ||
        !Number.isFinite(selectionInput.height) ||
        selectionInput.width <= 0 ||
        selectionInput.height <= 0
    ) {
        const error = new Error('Selection area missing or invalid.');
        error.name = 'SelectionAreaError';
        throw error;
    }

    const selection = clampRectToBounds(selectionInput);
    const selectionWidthPx = selection.width * containerWidth;
    const selectionHeightPx = selection.height * containerHeight;

    if (selectionWidthPx < 2 || selectionHeightPx < 2) {
        const error = new Error('Selection area is too small to analyze.');
        error.name = 'SelectionAreaError';
        throw error;
    }

    const devicePixelRatio = Number.isFinite(viewportSnapshot.devicePixelRatio)
        ? Math.max(1, viewportSnapshot.devicePixelRatio)
        : 1;
    const objectFit = (viewportSnapshot.objectFit || 'cover').toLowerCase();
    const transform = viewportSnapshot.transform || {};
    const userScale = Number.isFinite(transform.scale) ? Math.max(0.01, transform.scale) : 1;
    const translateX = Number.isFinite(transform.translateX) ? transform.translateX : 0;
    const translateY = Number.isFinite(transform.translateY) ? transform.translateY : 0;

    let baseScale;
    if (objectFit === 'contain') {
        baseScale = Math.min(containerWidth / naturalWidth, containerHeight / naturalHeight);
    } else {
        baseScale = Math.max(containerWidth / naturalWidth, containerHeight / naturalHeight);
    }

    if (!Number.isFinite(baseScale) || baseScale <= 0) {
        const error = new Error('Viewport scale unavailable.');
        error.name = 'ViewportScaleError';
        throw error;
    }

    const finalScale = baseScale * userScale;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(selectionWidthPx * devicePixelRatio));
    canvas.height = Math.max(1, Math.round(selectionHeightPx * devicePixelRatio));
    const ctx = canvas.getContext('2d');

    if (!ctx) {
        throw new Error('Canvas context unavailable for rendering.');
    }

    ctx.scale(devicePixelRatio, devicePixelRatio);
    ctx.fillStyle = '#05050c';
    ctx.fillRect(0, 0, selectionWidthPx, selectionHeightPx);
    ctx.imageSmoothingQuality = 'high';

    ctx.save();
    ctx.translate(-selection.x * containerWidth, -selection.y * containerHeight);
    ctx.translate(containerWidth / 2, containerHeight / 2);
    ctx.translate(translateX, translateY);
    ctx.scale(finalScale, finalScale);
    ctx.drawImage(
        image,
        -naturalWidth / 2,
        -naturalHeight / 2,
        naturalWidth,
        naturalHeight
    );
    ctx.restore();

    let outputCanvas = canvas;
    const maxSide = Math.max(canvas.width, canvas.height);
    if (maxSide > 640) {
        const scaleFactor = 640 / maxSide;
        const resizedCanvas = document.createElement('canvas');
        resizedCanvas.width = Math.max(1, Math.round(canvas.width * scaleFactor));
        resizedCanvas.height = Math.max(1, Math.round(canvas.height * scaleFactor));
        const resizedCtx = resizedCanvas.getContext('2d');
        if (!resizedCtx) {
            throw new Error('Canvas context unavailable for resizing.');
        }
        resizedCtx.imageSmoothingQuality = 'high';
        resizedCtx.drawImage(
            canvas,
            0,
            0,
            canvas.width,
            canvas.height,
            0,
            0,
            resizedCanvas.width,
            resizedCanvas.height
        );
        outputCanvas = resizedCanvas;
    }

    try {
        const jpegDataUrl = outputCanvas.toDataURL('image/jpeg', 0.85);
        if (typeof jpegDataUrl === 'string' && jpegDataUrl.startsWith('data:image/jpeg')) {
            return jpegDataUrl;
        }
    } catch (error) {
        console.warn('Falling back to PNG viewport rendering after JPEG export failure:', error);
    }

    return outputCanvas.toDataURL('image/png');
}

/**
 * Render analysis summary as readable text
 */
export function renderAnalysisSummary(analysis, discriminators) {
    if (!analysis) {
        return '';
    }

    const subject = analysis.subject || {};
    const appearance = analysis.appearance || {};
    const clothing = analysis.clothing || {};
    const accessories = analysis.accessories || {};
    const environment = analysis.environment || {};
    const confidence = analysis.confidence || {};

    const formatArray = (value) => Array.isArray(value) && value.length
        ? value.join(', ')
        : 'none';

    const formatObject = (value) => value && typeof value === 'object'
        ? Object.entries(value)
            .filter(([, v]) => v !== null && v !== undefined && v !== '')
            .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
            .join(' | ')
        : '';

    const subjectLines = [
        `Gender: ${subject.gender || 'unknown'} (${subject.genderConfidence ?? 'n/a'})`,
        `Age: ${subject.ageRange || subject.ageBucket || 'unknown'} (${subject.confidence?.age ?? 'n/a'})`,
        `Build: ${subject.build || subject.bodyType || 'unknown'} | Height: ${subject.heightCategory || 'unknown'}`,
        `Skin tone: ${subject.skinTone || 'unknown'} | Hair: ${formatObject(subject.hair) || 'unknown'}`,
        `Facial hair: ${subject.facialHair || 'none'} | Eyewear: ${subject.eyewear || 'none'} | Headwear: ${subject.headwear || 'none'}`,
        `Distinctive: ${formatArray(subject.distinguishingFeatures)}`
    ];

    const appearanceLines = [
        `Dominant colours: ${formatArray(appearance.dominantColors)}`,
        `Palette: ${formatObject(appearance.colorPalette) || 'n/a'}`,
        `Style tags: ${formatArray(appearance.styleDescriptors)}`,
        `Patterns/textures: ${formatArray(appearance.patterns)}`
    ];

    const clothingLines = [
        `Top: ${formatObject(clothing.top) || 'unknown'}`,
        `Bottom: ${formatObject(clothing.bottom) || 'unknown'}`,
        `Outerwear: ${formatObject(clothing.outerwear) || 'none'}`,
        `Footwear: ${formatObject(clothing.footwear) || 'unknown'}`,
        `Layers: ${formatArray(clothing.additionalLayers)}`
    ];

    const accessoryLines = Object.entries(accessories)
        .map(([bucket, values]) => `${bucket}: ${formatArray(values)}`)
        .join('\n');

    const environmentLines = [
        `Setting: ${environment.setting || 'unknown'} | Background: ${environment.background || 'unknown'}`,
        `Lighting: ${environment.lighting || 'unknown'} | Crowd: ${environment.crowdLevel || 'unknown'}`
    ];

    const discriminatorLines = discriminators
        ? Object.entries(discriminators)
            .map(([key, value]) => `${key}: ${value}`)
            .join(', ')
        : '';

    const confidenceLines = [
        `Confidence overall: ${confidence.overall ?? 'n/a'}`,
        `Gender/age/clothing/accessories: ${confidence.gender ?? 'n/a'} / ${confidence.age ?? 'n/a'} / ${confidence.clothing ?? 'n/a'} / ${confidence.accessories ?? 'n/a'}`
    ];

    const sections = [
        '[Subject]',
        ...subjectLines,
        '',
        '[Appearance]',
        ...appearanceLines,
        '',
        '[Clothing]',
        ...clothingLines,
        '',
        '[Accessories]',
        accessoryLines || 'none',
        '',
        '[Environment]',
        ...environmentLines,
        '',
        '[Discriminators]',
        discriminatorLines || 'none',
        '',
        '[Confidence]',
        ...confidenceLines
    ];

    return sections.join('\n');
}

/**
 * Enqueue analysis request
 */
function enqueueAnalysis(side, photoDataUrl, viewportSnapshot = null, options = {}) {
    if (!analysisEnabled) {
        return;
    }
    const slot = getPhotoSlotByAnalysisSide(side);
    if (slot && typeof photoDataUrl === 'string' && photoDataUrl.length > 0) {
        slot.lastPhotoDataUrl = photoDataUrl;
    }
    analysisQueue.push({ side, photoDataUrl, viewport: viewportSnapshot, options });
    processAnalysisQueue();
}

/**
 * Process analysis queue
 */
function processAnalysisQueue() {
    if (!analysisEnabled) {
        return;
    }
    if (getAnalysisInFlight()) {
        return;
    }

    const next = analysisQueue.shift();
    if (!next) {
        return;
    }

    setAnalysisInFlight(true);
    requestAnalysis(next.side, next.photoDataUrl, next.viewport, next.options)
        .catch(error => {
            console.error('Analysis request failed:', error);
        })
        .finally(() => {
            setAnalysisInFlight(false);
            processAnalysisQueue();
        });
}

/**
 * Request analysis from API
 */
async function requestAnalysis(side, photoDataUrl, viewportSnapshot, options = {}) {
    if (!analysisEnabled) {
        return;
    }
    const totalStart = now();
    let totalOutcome = 'ok';
    const state = analysisState[side];
    if (!state) {
        return;
    }

    const label = side === 'you' ? 'You' : 'Me';

    if (!ANALYSIS_API_URL) {
        setAnalysisState(side, 'error', `${label} analysis API is not configured.`);
        return;
    }

    setAnalysisState(side, 'loading', WAITING_FOR_ANALYSIS_MESSAGE, WAITING_FOR_ANALYSIS_MESSAGE);

    const capturedAt = typeof options.capturedAt === 'string' && options.capturedAt.length
        ? options.capturedAt
        : new Date().toISOString();

    const slotForCaching = getPhotoSlotByAnalysisSide(side);
    const locationSignature = typeof photoDataUrl === 'string' && photoDataUrl.length
        ? photoDataUrl.slice(0, 128)
        : null;

    let locationPayload;
    if (slotForCaching && locationSignature) {
        if (slotForCaching.cachedLocationSignature === locationSignature) {
            locationPayload = slotForCaching.cachedLocationPayload || null;
        } else {
            locationPayload = runWithTiming(
                `${label.toLowerCase()}-gps-extraction`,
                () => extractGpsLocationFromDataUrl(photoDataUrl)
            );
            slotForCaching.cachedLocationSignature = locationSignature;
            slotForCaching.cachedLocationPayload = locationPayload || null;
        }
    } else {
        locationPayload = runWithTiming(
            `${label.toLowerCase()}-gps-extraction`,
            () => extractGpsLocationFromDataUrl(photoDataUrl)
        );
    }

    if (!locationPayload && !missingGpsWarningShown.has(side)) {
        showWarning(`${label} photo is missing embedded GPS metadata. Location will be omitted from the analysis.`, {
            side,
            detail: 'EXIF GPS fields missing or unreadable'
        });
        missingGpsWarningShown.add(side);
    }

    let renderedViewportDataUrl;

    try {
        renderedViewportDataUrl = await runWithTiming(
            `${label.toLowerCase()}-viewport-render`,
            () => createViewportDataUrl(photoDataUrl, viewportSnapshot)
        );
    } catch (renderError) {
        let message;
        if (renderError?.name === 'SelectionAreaError') {
            message = `${label} analysis failed: adjust the white bounding box so it fully covers the subject, then try again.`;
        } else if (renderError?.name === 'ViewportNotReadyError') {
            message = `${label} analysis failed: viewing area is still loading. Hold steady and try again once the photo stabilizes.`;
        } else if (renderError?.name === 'ViewportScaleError') {
            message = `${label} analysis failed: unable to align the zoomed image. Re-center the photo and retry.`;
        } else {
            message = `${label} analysis failed: unable to render the framed view (${renderError?.message || 'unknown error.'})`;
        }
        setAnalysisState(side, 'error', message);
        const error = new Error(renderError?.message || 'Viewport rendering failed.');
        error.name = 'ViewportRenderingError';
        error.cause = renderError;
        throw error;
    }

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), ANALYSIS_API_TIMEOUT_MS);

    try {
        const response = await runWithTiming(
            `${label.toLowerCase()}-analysis-fetch`,
            () => fetch(ANALYSIS_API_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    role: side,
                    image: renderedViewportDataUrl,
                    viewport: viewportSnapshot,
                    reason: options.reason || 'interaction',
                    signature: options.signature || null,
                    capturedAt,
                    location: locationPayload
                }),
                signal: controller.signal
            })
        );

        if (!response.ok) {
            const errorText = await runWithTiming(
                `${label.toLowerCase()}-analysis-error-body`,
                () => response.text().catch(() => '')
            );
            let errorPayload = null;
            if (errorText) {
                try {
                    errorPayload = JSON.parse(errorText);
                } catch {
                    // leave payload null when not JSON
                }
            }
            if (errorPayload && typeof errorPayload === 'object' && !Array.isArray(errorPayload)) {
                const errorMessage = typeof errorPayload.error === 'string' ? errorPayload.error : null;
                const normalizedMessage = errorMessage ? errorMessage.trim().toLowerCase() : '';
                if (normalizedMessage.includes('truncated')) {
                    const truncatedError = new Error('AI response truncated before completion');
                    truncatedError.name = 'TruncatedAIResponseError';
                    truncatedError.payload = errorPayload;
                    truncatedError.status = response.status;
                    truncatedError.rawBody = errorText;
                    throw truncatedError;
                }
                const structuredError = new Error(errorMessage || `HTTP ${response.status}`);
                structuredError.name = 'AnalysisApiError';
                structuredError.payload = errorPayload;
                structuredError.status = response.status;
                structuredError.rawBody = errorText;
                throw structuredError;
            }
            const genericError = new Error(errorText || `HTTP ${response.status}`);
            genericError.name = 'AnalysisApiError';
            genericError.status = response.status;
            genericError.rawBody = errorText;
            throw genericError;
        }

        const payload = await runWithTiming(
            `${label.toLowerCase()}-analysis-parse`,
            () => response.json()
        );
        const statusFlag = typeof payload?.status === 'string'
            ? payload.status.trim().toLowerCase()
            : null;

        if (statusFlag === 'ok' && payload.analysis) {
            const summary = renderAnalysisSummary(payload.analysis, payload.discriminators);
            setAnalysisState(side, 'success', `${label} analysis ready.`, summary);

            analysisState[side].analysis = payload.analysis;
            analysisState[side].imageDataUrl = renderedViewportDataUrl;
            analysisState[side].capturedAt = capturedAt;
            analysisState[side].discriminators = payload.discriminators || {};

            console.log(`=== ${label.toUpperCase()} ANALYSIS RESPONSE ===`);
            console.log('Analysis:', payload.analysis);
            console.log('Discriminators:', payload.discriminators || {});

            storePhotoData(side, renderedViewportDataUrl, payload.analysis || null, capturedAt, payload.discriminators || null);

            addToHistory(side, {
                id: payload.recordId || Date.now(),
                analysis: payload.analysis || {},
                discriminators: payload.discriminators || {},
                status: statusFlag,
                role: side,
                capturedAt,
                createdAt: new Date().toISOString(),
                imageDataUrl: renderedViewportDataUrl,
                location: locationPayload
            });

            return;
        }

        if (statusFlag === 'unclear' || statusFlag === 'error') {
            const unclearMessage = statusFlag === 'unclear'
                ? 'Subject not clear. Retake a closer photo.'
                : 'Analysis failed. Retake the photo and try again.';
            setAnalysisState(
                side,
                'error',
                `${label} analysis unavailable: ${unclearMessage}`,
                ''
            );
            return;
        }

        throw new Error('API response did not include a usable analysis.');
    } catch (error) {
        if (error?.name !== 'ViewportRenderingError') {
            let message;
            let diagnosticDetail = error?.stack || error?.message || null;
            if (error?.name === 'AbortError') {
                message = `${label} analysis request timed out after ${Math.round(ANALYSIS_API_TIMEOUT_MS / 1000)}s.`;
            } else if (error?.name === 'TruncatedAIResponseError') {
                message = `${label} analysis failed: AI response was incomplete. Retry in a moment or adjust the framing, then try again.`;
                diagnosticDetail = {
                    finishReason: error?.payload?.finishReason ?? null,
                    cleanupReason: error?.payload?.cleanupReason ?? null,
                    statusCode: error?.status ?? null,
                    rawBody: error?.rawBody ?? null
                };
            } else {
                message = `${label} analysis failed: ${error?.message || 'Unknown error.'}`;
                if (error?.payload) {
                    diagnosticDetail = {
                        ...error.payload,
                        statusCode: error?.status ?? null,
                        rawBody: error?.rawBody ?? null
                    };
                }
            }
            setAnalysisState(side, 'error', message);
            appendDiagnosticMessage(side, message, {
                level: 'error',
                detail: diagnosticDetail
            });
        }
        totalOutcome = 'error';
        throw error;
    } finally {
        window.clearTimeout(timeoutId);
        logTiming(`${label.toLowerCase()}-analysis-total`, now() - totalStart, totalOutcome);
    }
}

