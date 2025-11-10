// Selection box logic

import { DEFAULT_SELECTION_RECT, MIN_SELECTION_EDGE_PX } from './config.js';
import { photoSlots, selectionState, interactionState, selectionElements } from './state.js';
import { clamp, cloneSelectionRect, getSelectionElements, getSelectionMinSize, clampRectToBounds } from './utils.js';
import { getCameraHalfElement } from './camera.js';
import { scheduleViewportDescription } from './description-api.js';
import { clearMovementDebounce } from './zoom.js';

/**
 * Show/hide selection overlay
 */
export function setSelectionOverlayVisibility(slotKey, isVisible) {
    const elements = getSelectionElements(slotKey);
    if (!elements?.overlay) {
        return;
    }
    if (isVisible) {
        elements.overlay.classList.add('is-visible');
        elements.overlay.setAttribute('aria-hidden', 'false');
        if (elements.box) {
            elements.box.setAttribute('aria-hidden', 'false');
        }
    } else {
        elements.overlay.classList.remove('is-visible');
        elements.overlay.setAttribute('aria-hidden', 'true');
        if (elements.box) {
            elements.box.setAttribute('aria-hidden', 'true');
        }
    }
}

export function showSelectionOverlay(slotKey) {
    setSelectionOverlayVisibility(slotKey, true);
}

export function hideSelectionOverlay(slotKey) {
    setSelectionOverlayVisibility(slotKey, false);
}

/**
 * Update selection box CSS styles
 */
export function updateSelectionStyles(slotKey) {
    const state = selectionState[slotKey];
    const elements = getSelectionElements(slotKey);
    if (!state || !elements?.box) {
        return;
    }
    const { x, y, width, height } = clampRectToBounds(state.rect);
    const box = elements.box;
    box.style.left = `${(x * 100).toFixed(3)}%`;
    box.style.top = `${(y * 100).toFixed(3)}%`;
    box.style.width = `${(width * 100).toFixed(3)}%`;
    box.style.height = `${(height * 100).toFixed(3)}%`;
}

/**
 * Sync selection interaction CSS classes
 */
export function syncSelectionInteractionClasses(slotKey) {
    const state = selectionState[slotKey];
    const elements = getSelectionElements(slotKey);
    if (!state || !elements?.box) {
        return;
    }
    const isMoving = state.mode === 'move' && state.activePointerId !== null;
    const isResizing = state.activePointerId !== null && state.mode && state.mode !== 'move';
    elements.box.classList.toggle('is-moving', isMoving);
    elements.box.classList.toggle('is-resizing', isResizing);
}

/**
 * Reset selection rect to default
 */
export function resetSelectionRect(slotKey, { notify = false } = {}) {
    const state = selectionState[slotKey];
    if (!state) {
        return;
    }
    let rect = cloneSelectionRect();
    const container = getCameraHalfElement(slotKey);
    if (container) {
        const bounds = container.getBoundingClientRect();
        if (bounds && Number.isFinite(bounds.width) && Number.isFinite(bounds.height) && bounds.width > 0 && bounds.height > 0) {
            const minSize = getSelectionMinSize(bounds);
            const centerX = rect.x + rect.width / 2;
            const centerY = rect.y + rect.height / 2;
            rect.width = Math.max(rect.width, minSize.width);
            rect.height = Math.max(rect.height, minSize.height);
            rect.width = clamp(rect.width, 0.05, 0.96);
            rect.height = clamp(rect.height, 0.05, 0.96);
            rect.x = clamp(centerX - rect.width / 2, 0, 1 - rect.width);
            rect.y = clamp(centerY - rect.height / 2, 0, 1 - rect.height);
        }
    }
    state.rect = clampRectToBounds(rect);
    updateSelectionStyles(slotKey);
    if (notify) {
        const interaction = interactionState[slotKey];
        if (interaction) {
            interaction.lastSubmittedSignature = null;
            clearMovementDebounce(slotKey);
        }
        scheduleViewportDescription(slotKey, { reason: 'selection-reset', force: true });
    }
}

/**
 * Get pointer context relative to container
 */
function getSelectionPointerContext(slotKey, event) {
    const container = getCameraHalfElement(slotKey);
    if (!container) {
        return null;
    }
    const rect = container.getBoundingClientRect();
    if (!rect || !rect.width || !rect.height || !Number.isFinite(rect.width) || !Number.isFinite(rect.height)) {
        return null;
    }
    const relativeX = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    const relativeY = clamp((event.clientY - rect.top) / rect.height, 0, 1);
    return {
        relativeX,
        relativeY,
        containerRect: rect
    };
}

/**
 * Compute resized selection rect
 */
function computeResizedSelectionRect(handle, startRect, point, minSize) {
    const startRight = startRect.x + startRect.width;
    const startBottom = startRect.y + startRect.height;
    let next = { ...startRect };

    if (handle === 'top-left') {
        const newX = clamp(point.x, 0, startRight - minSize.width);
        const newY = clamp(point.y, 0, startBottom - minSize.height);
        next.x = newX;
        next.y = newY;
        next.width = startRight - newX;
        next.height = startBottom - newY;
    } else if (handle === 'top-right') {
        const newRight = clamp(point.x, startRect.x + minSize.width, 1);
        const newTop = clamp(point.y, 0, startBottom - minSize.height);
        next.y = newTop;
        next.width = newRight - startRect.x;
        next.height = startBottom - newTop;
    } else if (handle === 'bottom-left') {
        const newLeft = clamp(point.x, 0, startRight - minSize.width);
        const newBottom = clamp(point.y, startRect.y + minSize.height, 1);
        next.x = newLeft;
        next.width = startRight - newLeft;
        next.height = newBottom - startRect.y;
    } else if (handle === 'bottom-right') {
        const newRight = clamp(point.x, startRect.x + minSize.width, 1);
        const newBottom = clamp(point.y, startRect.y + minSize.height, 1);
        next.width = newRight - startRect.x;
        next.height = newBottom - startRect.y;
    }

    return clampRectToBounds(next);
}

/**
 * Check if selection has an active photo
 */
function selectionHasActivePhoto(slotKey) {
    const slot = photoSlots[slotKey];
    if (!slot?.imageEl) {
        return false;
    }
    return slot.imageEl.classList.contains('active') && typeof slot.lastPhotoDataUrl === 'string' && slot.lastPhotoDataUrl.length > 0;
}

/**
 * Start selection interaction (move or resize)
 */
function startSelectionInteraction(slotKey, mode, event) {
    if (event && typeof event.button === 'number' && event.button !== 0 && event.pointerType !== 'touch') {
        return;
    }
    const state = selectionState[slotKey];
    const elements = getSelectionElements(slotKey);
    if (!state || !elements?.box) {
        return;
    }
    if (state.activePointerId !== null && state.activePointerId !== event.pointerId) {
        return;
    }
    const pointerContext = getSelectionPointerContext(slotKey, event);
    if (!pointerContext) {
        console.warn('Selection interaction skipped: container bounds unavailable.');
        return;
    }
    event.preventDefault();
    event.stopPropagation();

    state.activePointerId = event.pointerId;
    state.mode = mode;
    state.startRect = { ...state.rect };
    state.startPoint = { x: pointerContext.relativeX, y: pointerContext.relativeY };
    state.lastInteractionAt = performance.now();
    state.activeElement = event.currentTarget || null;

    if (state.activeElement && typeof state.activeElement.setPointerCapture === 'function') {
        try {
            state.activeElement.setPointerCapture(event.pointerId);
        } catch (captureError) {
            console.warn('Unable to capture pointer for selection interaction:', captureError);
        }
    }

    syncSelectionInteractionClasses(slotKey);
}

/**
 * Continue selection interaction
 */
function continueSelectionInteraction(slotKey, event) {
    const state = selectionState[slotKey];
    if (!state || state.activePointerId !== event.pointerId || !state.mode || !state.startRect || !state.startPoint) {
        return;
    }

    const pointerContext = getSelectionPointerContext(slotKey, event);
    if (!pointerContext) {
        return;
    }

    event.preventDefault();
    event.stopPropagation();

    const containerRect = pointerContext.containerRect;
    const minSize = getSelectionMinSize(containerRect);
    let nextRect;

    if (state.mode === 'move') {
        const deltaX = pointerContext.relativeX - state.startPoint.x;
        const deltaY = pointerContext.relativeY - state.startPoint.y;
        const maxX = 1 - state.startRect.width;
        const maxY = 1 - state.startRect.height;
        nextRect = {
            x: clamp(state.startRect.x + deltaX, 0, maxX),
            y: clamp(state.startRect.y + deltaY, 0, maxY),
            width: state.startRect.width,
            height: state.startRect.height
        };
    } else {
        nextRect = computeResizedSelectionRect(
            state.mode,
            state.startRect,
            { x: pointerContext.relativeX, y: pointerContext.relativeY },
            minSize
        );
    }

    nextRect = clampRectToBounds(nextRect);

    if (
        Math.abs(nextRect.x - state.rect.x) < 0.0001 &&
        Math.abs(nextRect.y - state.rect.y) < 0.0001 &&
        Math.abs(nextRect.width - state.rect.width) < 0.0001 &&
        Math.abs(nextRect.height - state.rect.height) < 0.0001
    ) {
        return;
    }

    state.rect = nextRect;
    state.lastInteractionAt = performance.now();
    updateSelectionStyles(slotKey);

    if (selectionHasActivePhoto(slotKey)) {
        scheduleViewportDescription(slotKey, { reason: 'selection-change' });
    }
}

/**
 * Finish selection interaction
 */
function finishSelectionInteraction(slotKey, event) {
    const state = selectionState[slotKey];
    if (!state || state.activePointerId !== event.pointerId) {
        return;
    }

    event.preventDefault();
    event.stopPropagation();

    if (state.activeElement && typeof state.activeElement.releasePointerCapture === 'function') {
        try {
            state.activeElement.releasePointerCapture(event.pointerId);
        } catch (releaseError) {
            // Ignore release errors.
        }
    }

    state.activePointerId = null;
    state.mode = null;
    state.startRect = null;
    state.startPoint = null;
    state.activeElement = null;

    syncSelectionInteractionClasses(slotKey);

    if (selectionHasActivePhoto(slotKey)) {
        scheduleViewportDescription(slotKey, { reason: 'selection-release' });
    }
}

/**
 * Setup selection interaction event listeners
 */
export function setupSelectionInteractions(slotKey) {
    const elements = getSelectionElements(slotKey);
    if (!elements?.box) {
        return;
    }

    const box = elements.box;

    const handleBoxPointerDown = (event) => {
        if (event.target !== box) {
            return;
        }
        startSelectionInteraction(slotKey, 'move', event);
    };

    box.addEventListener('pointerdown', handleBoxPointerDown);
    box.addEventListener('pointermove', (event) => continueSelectionInteraction(slotKey, event));
    box.addEventListener('pointerup', (event) => finishSelectionInteraction(slotKey, event));
    box.addEventListener('pointercancel', (event) => finishSelectionInteraction(slotKey, event));

    Object.entries(elements.handles || {}).forEach(([handleKey, handleElement]) => {
        if (!handleElement) {
            return;
        }
        handleElement.addEventListener('pointerdown', (event) => {
            startSelectionInteraction(slotKey, handleKey, event);
        });
        handleElement.addEventListener('pointermove', (event) => continueSelectionInteraction(slotKey, event));
        handleElement.addEventListener('pointerup', (event) => finishSelectionInteraction(slotKey, event));
        handleElement.addEventListener('pointercancel', (event) => finishSelectionInteraction(slotKey, event));
    });
}

