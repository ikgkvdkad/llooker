// Zoom and transform logic

import { photoSlots, interactionState, selectionState, getBackStream, getSelfieStream } from './state.js';
import { clampRectToBounds } from './utils.js';
import { getCameraHalfElement } from './camera.js';

/**
 * Snapshot viewport state for analysis API
 */
export function snapshotViewportState(slotKey) {
    const slot = photoSlots[slotKey];
    const state = interactionState[slotKey];
    const container = getCameraHalfElement(slotKey);
    if (!slot || !state || !slot?.imageEl || !container) {
        return null;
    }

    const rect = container.getBoundingClientRect();
    const containerWidth = rect?.width;
    const containerHeight = rect?.height;
    const naturalWidth = slot.imageEl.naturalWidth || slot.imageEl.videoWidth || slot.imageEl.width;
    const naturalHeight = slot.imageEl.naturalHeight || slot.imageEl.videoHeight || slot.imageEl.height;

    if (
        !containerWidth ||
        !containerHeight ||
        !naturalWidth ||
        !naturalHeight ||
        !Number.isFinite(containerWidth) ||
        !Number.isFinite(containerHeight)
    ) {
        return null;
    }

    const computedStyle = window.getComputedStyle(slot.imageEl);
    const objectFit = computedStyle?.objectFit || 'cover';
    const transformScale = Number.isFinite(state.transform?.scale) ? state.transform.scale : 1;
    const transformTranslateX = Number.isFinite(state.transform?.translateX) ? state.transform.translateX : 0;
    const transformTranslateY = Number.isFinite(state.transform?.translateY) ? state.transform.translateY : 0;
    const selectionRect = selectionState[slotKey]?.rect
        ? clampRectToBounds(selectionState[slotKey].rect)
        : null;

    return {
        containerWidth,
        containerHeight,
        naturalWidth,
        naturalHeight,
        objectFit,
        transform: {
            scale: Math.max(0.01, transformScale),
            translateX: transformTranslateX,
            translateY: transformTranslateY
        },
        devicePixelRatio: window.devicePixelRatio && Number.isFinite(window.devicePixelRatio)
            ? Math.max(1, window.devicePixelRatio)
            : 1,
        selection: selectionRect ? { ...selectionRect } : null
    };
}

/**
 * Reset photo transform to default
 */
export function resetPhotoTransform(slotKey) {
    const state = interactionState[slotKey];
    const slot = photoSlots[slotKey];
    if (!state || !slot?.imageEl) {
        return;
    }
    state.transform.scale = 1;
    state.transform.translateX = 0;
    state.transform.translateY = 0;
    applyPhotoTransform(slotKey);
}

/**
 * Clamp photo translation to bounds
 */
export function clampPhotoTranslation(slotKey) {
    const state = interactionState[slotKey];
    const slot = photoSlots[slotKey];
    const container = getCameraHalfElement(slotKey);
    if (!state || !slot?.imageEl || !container) {
        return;
    }

    const { scale } = state.transform;
    const boundsWidth = container.clientWidth;
    const boundsHeight = container.clientHeight;
    if (!boundsWidth || !boundsHeight) {
        return;
    }

    const overflowX = Math.max(0, ((scale - 1) * boundsWidth) / 2);
    const overflowY = Math.max(0, ((scale - 1) * boundsHeight) / 2);
    const freeTravelX = boundsWidth * 0.75;
    const freeTravelY = boundsHeight * 0.75;

    const maxOffsetX = overflowX + freeTravelX;
    const maxOffsetY = overflowY + freeTravelY;

    state.transform.translateX = Math.min(
        Math.max(state.transform.translateX, -maxOffsetX),
        maxOffsetX
    );

    state.transform.translateY = Math.min(
        Math.max(state.transform.translateY, -maxOffsetY),
        maxOffsetY
    );
}

/**
 * Apply photo transform CSS
 */
export function applyPhotoTransform(slotKey) {
    const slot = photoSlots[slotKey];
    const state = interactionState[slotKey];
    if (!slot?.imageEl || !state) {
        return;
    }

    clampPhotoTranslation(slotKey);
    const { scale, translateX, translateY } = state.transform;
    slot.imageEl.style.transform = `translate(${translateX}px, ${translateY}px) scale(${scale})`;
}

/**
 * Clear movement debounce timer
 */
export function clearMovementDebounce(slotKey) {
    const state = interactionState[slotKey];
    if (!state) {
        return;
    }
    if (state.movementDebounceId !== null) {
        window.clearTimeout(state.movementDebounceId);
        state.movementDebounceId = null;
    }
}

/**
 * Initialize zoom state from camera track
 */
export function initializeZoomStateFromTrack(slotKey, track) {
    const state = interactionState[slotKey];
    if (!state || !track) {
        return;
    }

    let capabilities = null;
    let settings = null;

    if (typeof track.getCapabilities === 'function') {
        capabilities = track.getCapabilities();
    }
    if (typeof track.getSettings === 'function') {
        settings = track.getSettings();
    }

    const zoomCapabilities = capabilities?.zoom;
    if (zoomCapabilities && typeof zoomCapabilities.min === 'number' && typeof zoomCapabilities.max === 'number') {
        state.zoomSupported = true;
        state.streamZoom.min = zoomCapabilities.min;
        state.streamZoom.max = zoomCapabilities.max;
    } else {
        state.zoomSupported = false;
        state.streamZoom.min = 1;
        state.streamZoom.max = 1;
    }

    if (typeof settings?.zoom === 'number') {
        state.streamZoom.current = settings.zoom;
    } else if (state.zoomSupported) {
        state.streamZoom.current = state.streamZoom.min;
    } else {
        state.streamZoom.current = 1;
    }
}

/**
 * Schedule camera zoom update
 */
export function scheduleCameraZoomUpdate(slotKey, targetZoom) {
    const state = interactionState[slotKey];
    if (!state) {
        return;
    }

    const clamped = Math.min(state.streamZoom.max, Math.max(state.streamZoom.min, targetZoom));
    state.pendingZoom = clamped;

    if (state.zoomUpdateFrame !== null) {
        return;
    }

    state.zoomUpdateFrame = requestAnimationFrame(() => {
        state.zoomUpdateFrame = null;
        if (state.zoomUpdateInFlight) {
            scheduleCameraZoomUpdate(slotKey, state.pendingZoom);
            return;
        }
        if (typeof state.pendingZoom === 'number') {
            applyStreamZoom(slotKey, state.pendingZoom);
        }
    });
}

/**
 * Apply stream zoom
 */
async function applyStreamZoom(slotKey, targetZoom) {
    const state = interactionState[slotKey];
    if (!state) {
        return;
    }

    const stream = slotKey === 'back' ? getBackStream() : getSelfieStream();
    const track = stream?.getVideoTracks?.()[0];
    if (!track) {
        return;
    }

    state.zoomUpdateInFlight = true;

    try {
        await track.applyConstraints({ advanced: [{ zoom: targetZoom }] });
        state.streamZoom.current = targetZoom;
    } catch (primaryError) {
        try {
            await track.applyConstraints({ zoom: targetZoom });
            state.streamZoom.current = targetZoom;
        } catch (secondaryError) {
            console.warn('Unable to apply pinch zoom:', secondaryError || primaryError);
            state.zoomSupported = false;
        }
    } finally {
        state.zoomUpdateInFlight = false;
        const pending = state.pendingZoom;
        state.pendingZoom = null;
        if (typeof pending === 'number' && Math.abs(pending - targetZoom) > 0.01) {
            scheduleCameraZoomUpdate(slotKey, pending);
        }
    }
}
