// AI description API communication

import { WAITING_FOR_DESCRIPTION_MESSAGE, DESCRIPTION_API_TIMEOUT_MS, DESCRIPTION_MOVEMENT_DEBOUNCE_MS, DESCRIPTION_API_URL } from './config.js';
import { photoSlots, interactionState, descriptionState, descriptionQueue, setDescriptionInFlight, getDescriptionInFlight } from './state.js';
import { getPhotoSlotByDescriptionSide, clampRectToBounds, loadImageElement } from './utils.js';
import { snapshotViewportState, clearMovementDebounce } from './zoom.js';
import { requestCurrentLocation } from './geo.js';
import { showWarning } from './ui.js';
import { addToHistory } from './history.js';
import { storeEmbedding } from './similarity.js';

/**
 * Reset description state for a side
 */
export function resetDescriptionState(side) {
    const state = descriptionState[side];
    if (!state) return;
    state.panel.classList.remove('loading', 'error', 'success');
    state.statusEl.textContent = side === 'you'
        ? 'Waiting for a You capture. Capture or upload a photo, then pan and zoom to center the subject.'
        : 'Waiting for a Me capture. Capture or upload your selfie, then center yourself in the frame.';
    state.contentEl.textContent = '';
}

/**
 * Set description state for a side
 */
export function setDescriptionState(side, status, message, descriptionText = '') {
    const state = descriptionState[side];
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
    state.contentEl.textContent = descriptionText;
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
 * Submit viewport description
 */
export function submitViewportDescription(slotKey, { force = false, reason = 'interaction' } = {}) {
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
    setDescriptionState(side, 'loading', WAITING_FOR_DESCRIPTION_MESSAGE, WAITING_FOR_DESCRIPTION_MESSAGE);
    enqueueDescription(side, photoDataUrl, viewport, {
        reason,
        signature,
        capturedAt: new Date().toISOString(),
        tone: 'neutral'
    });
}

/**
 * Schedule viewport description
 */
export function scheduleViewportDescription(slotKey, options = {}) {
    const state = interactionState[slotKey];
    if (!state) {
        return;
    }
    clearMovementDebounce(slotKey);
    const delay = options.immediate ? 0 : DESCRIPTION_MOVEMENT_DEBOUNCE_MS;
    state.movementDebounceId = window.setTimeout(() => {
        state.movementDebounceId = null;
        submitViewportDescription(slotKey, {
            force: options.force === true,
            reason: options.reason || 'interaction'
        });
    }, delay);
}

/**
 * Handle resubmit description
 */
export function handleResubmitDescription(side) {
    const slot = getPhotoSlotByDescriptionSide(side);
    const label = side === 'you' ? 'You' : 'Me';

    if (!slot) {
        console.warn(`No photo slot available for ${side} resubmission request.`);
        return;
    }

    const photoDataUrl = slot.lastPhotoDataUrl;
    const hasActivePhoto = !!(slot.imageEl && slot.imageEl.classList.contains('active'));

    if (!photoDataUrl) {
        const message = hasActivePhoto
            ? `${label} photo data is still loading. Try again shortly or capture a new photo.`
            : `${label} photo not captured yet. Capture a photo before requesting a description.`;
        setDescriptionState(side, 'error', message);
        return;
    }

    const slotKey = side === 'you' ? 'back' : 'selfie';
    const interaction = interactionState[slotKey];
    if (interaction) {
        interaction.lastSubmittedSignature = null;
        clearMovementDebounce(slotKey);
    }

    const submit = () => submitViewportDescription(slotKey, { force: true, reason: 'resubmit' });

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
async function createViewportDataUrl(photoDataUrl, viewportSnapshot) {
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

    return outputCanvas.toDataURL('image/png');
}

/**
 * Enqueue description request
 */
function enqueueDescription(side, photoDataUrl, viewportSnapshot = null, options = {}) {
    const slot = getPhotoSlotByDescriptionSide(side);
    if (slot && typeof photoDataUrl === 'string' && photoDataUrl.length > 0) {
        slot.lastPhotoDataUrl = photoDataUrl;
    }
    descriptionQueue.push({ side, photoDataUrl, viewport: viewportSnapshot, options });
    processDescriptionQueue();
}

/**
 * Process description queue
 */
function processDescriptionQueue() {
    if (getDescriptionInFlight()) {
        return;
    }

    const next = descriptionQueue.shift();
    if (!next) {
        return;
    }

    setDescriptionInFlight(true);
    requestDescription(next.side, next.photoDataUrl, next.viewport, next.options)
        .catch(error => {
            console.error('Description request failed:', error);
        })
        .finally(() => {
            setDescriptionInFlight(false);
            processDescriptionQueue();
        });
}

/**
 * Request description from API
 */
async function requestDescription(side, photoDataUrl, viewportSnapshot, options = {}) {
    const state = descriptionState[side];
    if (!state) {
        return;
    }

    const label = side === 'you' ? 'You' : 'Me';

    if (!DESCRIPTION_API_URL) {
        setDescriptionState(side, 'error', `${label} description API is not configured.`);
        return;
    }

    setDescriptionState(side, 'loading', WAITING_FOR_DESCRIPTION_MESSAGE, WAITING_FOR_DESCRIPTION_MESSAGE);

    const capturedAt = typeof options.capturedAt === 'string' && options.capturedAt.length
        ? options.capturedAt
        : new Date().toISOString();
    const tone = typeof options.tone === 'string' && options.tone.length
        ? options.tone
        : 'neutral';

    let locationPayload = null;
    try {
        const locationResult = await requestCurrentLocation();
        if (locationResult) {
            if (locationResult.status === 'ok' && locationResult.coords) {
                locationPayload = {
                    status: 'ok',
                    timestamp: locationResult.timestamp,
                    coords: {
                        latitude: locationResult.coords.latitude,
                        longitude: locationResult.coords.longitude,
                        accuracy: locationResult.coords.accuracy,
                        altitude: locationResult.coords.altitude,
                        altitudeAccuracy: locationResult.coords.altitudeAccuracy,
                        heading: locationResult.coords.heading,
                        speed: locationResult.coords.speed
                    }
                };
            } else {
                locationPayload = {
                    status: locationResult.status || 'unknown',
                    timestamp: locationResult.timestamp || Date.now(),
                    error: locationResult.error || 'Location unavailable.',
                    coords: null
                };
                const statusMessage = locationResult.error || `Geolocation status: ${locationResult.status}`;
                showWarning(`${label} location unavailable: ${statusMessage}`);
            }
        }
    } catch (locationError) {
        const message = locationError?.message || 'Unexpected geolocation failure.';
        console.error(`${label} location retrieval failed:`, locationError);
        showWarning(`${label} location error: ${message}`);
        locationPayload = {
            status: 'error',
            timestamp: Date.now(),
            error: message,
            coords: null
        };
    }

    let renderedViewportDataUrl;

    try {
        renderedViewportDataUrl = await createViewportDataUrl(photoDataUrl, viewportSnapshot);
    } catch (renderError) {
        let message;
        if (renderError?.name === 'SelectionAreaError') {
            message = `${label} description failed: adjust the white bounding box so it fully covers the subject, then try again.`;
        } else if (renderError?.name === 'ViewportNotReadyError') {
            message = `${label} description failed: viewing area is still loading. Hold steady and try again once the photo stabilizes.`;
        } else if (renderError?.name === 'ViewportScaleError') {
            message = `${label} description failed: unable to align the zoomed image. Re-center the photo and retry.`;
        } else {
            message = `${label} description failed: unable to render the framed view (${renderError?.message || 'unknown error.'})`;
        }
        setDescriptionState(side, 'error', message);
        const error = new Error(renderError?.message || 'Viewport rendering failed.');
        error.name = 'ViewportRenderingError';
        error.cause = renderError;
        throw error;
    }

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), DESCRIPTION_API_TIMEOUT_MS);

    try {
        const response = await fetch(DESCRIPTION_API_URL, {
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
                tone,
                location: locationPayload
            }),
            signal: controller.signal
        });

        if (!response.ok) {
            const errorText = await response.text().catch(() => '');
            throw new Error(errorText || `HTTP ${response.status}`);
        }

        const payload = await response.json();
        const statusFlag = typeof payload?.status === 'string'
            ? payload.status.trim().toLowerCase()
            : null;
        const descriptionText = typeof payload?.description === 'string'
            ? payload.description.trim()
            : '';

        if (statusFlag === 'ok' && descriptionText) {
            setDescriptionState(side, 'success', `${label} description ready.`, descriptionText);
            
            // Log API response for analysis
            console.log(`=== ${label.toUpperCase()} API RESPONSE ===`);
            console.log('Discriminative:', payload.discriminative || 'MISSING');
            console.log('Metadata:', payload.metadata || 'MISSING');
            console.log('Embedding dimensions:', payload.embedding?.length || 'MISSING');
            
            // Store embedding and metadata for similarity comparison
            if (payload.embedding && Array.isArray(payload.embedding)) {
                storeEmbedding(side, payload.embedding, payload.metadata || null);
            }
            
            // Add to history
            addToHistory(side, {
                id: payload.recordId || Date.now(), // Use DB ID if available
                description: descriptionText,
                metadata: payload.metadata || null,
                discriminative: payload.discriminative || '',
                status: statusFlag,
                role: side,
                capturedAt: capturedAt,
                createdAt: new Date().toISOString(),
                imageDataUrl: renderedViewportDataUrl,
                location: locationPayload,
                tone: tone
            });
            
            return;
        }

        if (statusFlag === 'unclear') {
            const unclearMessage = descriptionText || 'Unclear photo';
            setDescriptionState(
                side,
                'error',
                `${label} description unavailable: subject not clear. Retake a closer photo.`,
                unclearMessage
            );
            return;
        }

        throw new Error('API response did not include a usable description.');
    } catch (error) {
        if (error?.name !== 'ViewportRenderingError') {
            const message = error?.name === 'AbortError'
                ? `${label} description request timed out after ${Math.round(DESCRIPTION_API_TIMEOUT_MS / 1000)}s.`
                : `${label} description failed: ${error?.message || 'Unknown error.'}`;
            setDescriptionState(side, 'error', message);
        }
        throw error;
    } finally {
        window.clearTimeout(timeoutId);
    }
}
