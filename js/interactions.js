// Pointer and touch interaction handlers

import { TAP_MAX_MOVEMENT_PX, TAP_MAX_DURATION_MS } from './config.js';
import { interactionState } from './state.js';
import { calculateDistance } from './utils.js';
import { isCameraActive, isCameraFrozen, openBackCamera, openSelfieCamera, captureBackPhoto, captureSelfiePhoto, resetBackCamera, resetSelfieCamera } from './camera.js';
import { applyPhotoTransform, scheduleCameraZoomUpdate, clearMovementDebounce } from './zoom.js';
import { scheduleViewportAnalysis, submitViewportAnalysis } from './analysis-api.js';

/**
 * Reset pointer tracking for a slot
 */
export function resetPointerTracking(slotKey) {
    const state = interactionState[slotKey];
    if (!state) {
        return;
    }
    state.pointerMap.clear();
    state.baseDistance = null;
    state.baseZoom = null;
    state.panStart = null;
    state.tapCandidate = null;
    state.pendingZoom = null;
    if (state.zoomUpdateFrame !== null) {
        cancelAnimationFrame(state.zoomUpdateFrame);
        state.zoomUpdateFrame = null;
    }
    state.zoomUpdateInFlight = false;
    state.lastTap = null;
    clearMovementDebounce(slotKey);
}

/**
 * Get pointer entries from state
 */
function getPointerEntries(state) {
    if (!state) {
        return [];
    }
    return Array.from(state.pointerMap.values());
}

/**
 * Add pointer to state
 */
function addPointer(state, event) {
    state.pointerMap.set(event.pointerId, {
        pointerId: event.pointerId,
        clientX: event.clientX,
        clientY: event.clientY,
        startX: event.clientX,
        startY: event.clientY
    });
}

/**
 * Update pointer in state
 */
function updatePointer(state, event) {
    const entry = state.pointerMap.get(event.pointerId);
    if (!entry) {
        return;
    }
    entry.clientX = event.clientX;
    entry.clientY = event.clientY;
}

/**
 * Remove pointer from state
 */
function removePointer(state, pointerId) {
    if (!state) {
        return;
    }
    state.pointerMap.delete(pointerId);
}

/**
 * Handle pointer down on camera half
 */
export function handlePointerDownOnHalf(slotKey, event) {
    const state = interactionState[slotKey];
    if (!state) {
        return;
    }

    event.preventDefault();

    const target = event.currentTarget;
    if (target && typeof target.setPointerCapture === 'function') {
        try {
            target.setPointerCapture(event.pointerId);
        } catch (captureError) {
            console.warn('Failed to set pointer capture:', captureError);
        }
    }

    addPointer(state, event);

    if (state.pointerMap.size === 1) {
        state.baseDistance = null;
        state.baseZoom = null;
        state.tapCandidate = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            startTime: performance.now()
        };

        if (isCameraFrozen(slotKey)) {
            state.panStart = {
                pointerId: event.pointerId,
                startX: event.clientX,
                startY: event.clientY,
                originX: state.transform.translateX,
                originY: state.transform.translateY
            };
        } else {
            state.panStart = null;
        }
    } else if (state.pointerMap.size === 2) {
        const pointers = getPointerEntries(state);
        state.baseDistance = calculateDistance(pointers[0], pointers[1]);
        if (state.baseDistance < 0.01) {
            state.baseDistance = 0;
        }

        if (isCameraActive(slotKey) && state.zoomSupported) {
            state.baseZoom = state.streamZoom.current || state.streamZoom.min || 1;
        } else if (isCameraFrozen(slotKey)) {
            state.baseZoom = state.transform.scale || 1;
        } else {
            state.baseZoom = null;
        }

        state.tapCandidate = null;
        state.panStart = null;
    } else {
        state.tapCandidate = null;
        state.panStart = null;
        state.baseDistance = null;
        state.baseZoom = null;
    }
}

/**
 * Handle pointer move on camera half
 */
export function handlePointerMoveOnHalf(slotKey, event) {
    const state = interactionState[slotKey];
    if (!state) {
        return;
    }

    updatePointer(state, event);
    let viewportChanged = false;

    if (state.pointerMap.size === 2 && state.baseDistance) {
        const pointers = getPointerEntries(state);
        const distance = calculateDistance(pointers[0], pointers[1]);
        if (distance > 0 && state.baseDistance > 0) {
            const scaleFactor = distance / state.baseDistance;

            if (isCameraActive(slotKey) && state.zoomSupported && state.baseZoom) {
                const targetZoom = state.baseZoom * scaleFactor;
                scheduleCameraZoomUpdate(slotKey, targetZoom);
            } else if (isCameraFrozen(slotKey)) {
                const baseScale = state.baseZoom || 1;
                let targetScale = baseScale * scaleFactor;
                targetScale = Math.min(state.transformBounds.maxScale, Math.max(1, targetScale));
                if (Math.abs(targetScale - state.transform.scale) > 0.005) {
                    state.transform.scale = targetScale;
                    applyPhotoTransform(slotKey);
                    viewportChanged = true;
                }
            }
        }
        state.tapCandidate = null;
    } else if (
        state.pointerMap.size === 1 &&
        state.panStart &&
        state.panStart.pointerId === event.pointerId &&
        isCameraFrozen(slotKey)
    ) {
        const deltaX = event.clientX - state.panStart.startX;
        const deltaY = event.clientY - state.panStart.startY;
        state.transform.translateX = state.panStart.originX + deltaX;
        state.transform.translateY = state.panStart.originY + deltaY;
        applyPhotoTransform(slotKey);
        viewportChanged = true;
    }

    if (state.tapCandidate && state.tapCandidate.pointerId === event.pointerId) {
        const dx = event.clientX - state.tapCandidate.startX;
        const dy = event.clientY - state.tapCandidate.startY;
        if (Math.hypot(dx, dy) > TAP_MAX_MOVEMENT_PX) {
            state.tapCandidate = null;
        }
    }

    if (viewportChanged) {
        state.lastInteractionAt = performance.now();
        scheduleViewportAnalysis(slotKey, { reason: 'interaction' });
    }
}

/**
 * Handle pointer up on camera half
 */
export function handlePointerUpOnHalf(slotKey, event) {
    const state = interactionState[slotKey];
    if (!state) {
        return;
    }

    const target = event.currentTarget;
    if (target && typeof target.releasePointerCapture === 'function') {
        try {
            target.releasePointerCapture(event.pointerId);
        } catch (releaseError) {
            // Ignore release errors
        }
    }

    let isTap = false;
    if (state.tapCandidate && state.tapCandidate.pointerId === event.pointerId) {
        const duration = performance.now() - state.tapCandidate.startTime;
        const dx = event.clientX - state.tapCandidate.startX;
        const dy = event.clientY - state.tapCandidate.startY;
        if (duration <= TAP_MAX_DURATION_MS && Math.hypot(dx, dy) <= TAP_MAX_MOVEMENT_PX) {
            isTap = true;
        }
    }

    removePointer(state, event.pointerId);

    state.tapCandidate = null;

    if (state.pointerMap.size === 0) {
        state.baseDistance = null;
        state.baseZoom = null;
        state.panStart = null;
    } else if (state.pointerMap.size === 1 && isCameraFrozen(slotKey)) {
        const [remainingPointer] = getPointerEntries(state);
        state.panStart = {
            pointerId: remainingPointer.pointerId,
            startX: remainingPointer.clientX,
            startY: remainingPointer.clientY,
            originX: state.transform.translateX,
            originY: state.transform.translateY
        };
        state.baseDistance = null;
        state.baseZoom = null;
    } else {
        state.baseDistance = null;
        state.baseZoom = null;
        state.panStart = null;
    }

    if (isTap) {
        handleTapOnHalf(slotKey, event);
    }
}

/**
 * Handle pointer cancel on camera half
 */
export function handlePointerCancelOnHalf(slotKey, event) {
    const state = interactionState[slotKey];
    if (!state) {
        return;
    }

    removePointer(state, event.pointerId);
    state.tapCandidate = null;
    if (state.pointerMap.size === 0) {
        state.baseDistance = null;
        state.baseZoom = null;
        state.panStart = null;
    } else if (state.pointerMap.size === 1 && isCameraFrozen(slotKey)) {
        const [remainingPointer] = getPointerEntries(state);
        state.panStart = {
            pointerId: remainingPointer.pointerId,
            startX: remainingPointer.clientX,
            startY: remainingPointer.clientY,
            originX: state.transform.translateX,
            originY: state.transform.translateY
        };
        state.baseDistance = null;
        state.baseZoom = null;
    } else {
        state.baseDistance = null;
        state.baseZoom = null;
        state.panStart = null;
    }
}

/**
 * Handle tap on camera half
 */
export function handleTapOnHalf(slotKey, event) {
    const state = interactionState[slotKey];
    if (!state) {
        return;
    }

    const now = performance.now();
    const isFrozen = isCameraFrozen(slotKey);
    const isActive = isCameraActive(slotKey);

    if (isFrozen) {
        const lastTap = state.lastTap;
        const isDoubleTap =
            lastTap &&
            now - lastTap.time < 400 &&
            Math.hypot(
                event.clientX - lastTap.clientX,
                event.clientY - lastTap.clientY
            ) < 48;

        state.lastTap = { time: now, clientX: event.clientX, clientY: event.clientY };

        if (isDoubleTap) {
            if (slotKey === 'back') {
                resetBackCamera();
                openBackCamera().catch(error => console.error('Failed to reopen back camera:', error));
            } else if (slotKey === 'selfie') {
                resetSelfieCamera();
                openSelfieCamera().catch(error => console.error('Failed to reopen selfie camera:', error));
            }
            return;
        }

        submitViewportAnalysis(slotKey, { force: true, reason: 'tap' });
        return;
    }

    state.lastTap = { time: now, clientX: event.clientX, clientY: event.clientY };

    if (isActive) {
        if (slotKey === 'back') {
            captureBackPhoto();
        } else if (slotKey === 'selfie') {
            captureSelfiePhoto();
        }
        return;
    }

    if (slotKey === 'back') {
        openBackCamera().catch(error => console.error('Failed to open back camera:', error));
    } else if (slotKey === 'selfie') {
        openSelfieCamera().catch(error => console.error('Failed to open selfie camera:', error));
    }
}
