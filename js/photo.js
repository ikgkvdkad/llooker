// Photo capture and display logic

import * as dom from './dom.js';
import { photoSlots, interactionState, selectionState, setIsBackFrozen, setIsSelfieFrozen } from './state.js';
import { cloneSelectionRect } from './utils.js';
import { hideSelectionOverlay, showSelectionOverlay, updateSelectionStyles, syncSelectionInteractionClasses, resetSelectionRect } from './selection.js';
import { resetPhotoTransform, clearMovementDebounce } from './zoom.js';
import { scheduleViewportDescription } from './description-api.js';

/**
 * Initialize a photo slot to its default state
 */
export function initializePhotoSlot(slotKey) {
    const slot = photoSlots[slotKey];
    if (!slot) {
        return;
    }

    slot.lastPhotoDataUrl = null;

    if (slot.imageEl) {
        slot.imageEl.classList.remove('active');
        slot.imageEl.removeAttribute('src');
    }

    if (slot.placeholderEl) {
        slot.placeholderEl.classList.remove('hidden');
    }

    hideSelectionOverlay(slotKey);

    const selection = selectionState[slotKey];
    if (selection) {
        selection.rect = cloneSelectionRect();
        selection.activePointerId = null;
        selection.mode = null;
        selection.startRect = null;
        selection.startPoint = null;
        selection.activeElement = null;
        selection.lastInteractionAt = 0;
    }

    updateSelectionStyles(slotKey);
    syncSelectionInteractionClasses(slotKey);

    const interaction = interactionState[slotKey];
    if (interaction) {
        interaction.lastSubmittedSignature = null;
        clearMovementDebounce(slotKey);
    }
}

/**
 * Prepare a slot for live camera view
 */
export function prepareSlotForLiveView(slotKey) {
    initializePhotoSlot(slotKey);
    const slot = photoSlots[slotKey];
    if (slot?.placeholderEl) {
        slot.placeholderEl.classList.add('hidden');
    }
}

/**
 * Display a captured or uploaded photo
 */
export function displayPhotoForSide(side, dataUrl) {
    if (typeof dataUrl !== 'string' || dataUrl.length === 0) {
        throw new Error('Invalid photo data.');
    }

    const slotKey = side === 'you' ? 'back' : 'selfie';
    const slot = photoSlots[slotKey];

    if (!slot || !slot.imageEl) {
        throw new Error('Photo slot unavailable.');
    }

    slot.lastPhotoDataUrl = dataUrl;
    slot.imageEl.src = dataUrl;
    slot.imageEl.classList.add('active');
    showSelectionOverlay(slotKey);
    resetSelectionRect(slotKey, { notify: false });
    resetPhotoTransform(slotKey);
    const state = interactionState[slotKey];
    if (state) {
        state.lastTap = null;
        state.lastSubmittedSignature = null;
        clearMovementDebounce(slotKey);
    }

    if (slot.placeholderEl) {
        slot.placeholderEl.classList.add('hidden');
    }

    if (slotKey === 'back') {
        dom.backVideoElement.classList.remove('active');
        dom.backPlaceholder.classList.add('hidden');
        dom.backCameraHalf.classList.remove('initializing');
        setIsBackFrozen(true);
    } else if (slotKey === 'selfie') {
        dom.selfieVideoElement.classList.remove('active');
        dom.selfiePlaceholder.classList.add('hidden');
        setIsSelfieFrozen(true);
    }
    
    const schedule = () => scheduleViewportDescription(slotKey, { force: true, reason: 'photo-load' });
    if (slot.imageEl.complete && slot.imageEl.naturalWidth > 0) {
        schedule();
    } else {
        const handleImageLoad = () => {
            slot.imageEl.removeEventListener('load', handleImageLoad);
            schedule();
        };
        slot.imageEl.addEventListener('load', handleImageLoad, { once: true });
    }
}

