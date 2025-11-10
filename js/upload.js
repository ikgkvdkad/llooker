// File upload handling

import { readFileAsDataUrl } from './utils.js';
import { displayPhotoForSide } from './photo.js';
import { stopAllCameras } from './camera.js';
import { showError, hideError } from './ui.js';
import { setDescriptionState, handleResubmitDescription } from './description-api.js';

export function attachUploadHandler(button, input, side) {
    if (!button || !input) {
        return;
    }

    const triggerInputSelection = () => {
        input.click();
    };

    let suppressNextClick = false;
    let suppressTimerId = null;

    const clearSuppressTimer = () => {
        if (suppressTimerId !== null) {
            window.clearTimeout(suppressTimerId);
            suppressTimerId = null;
        }
    };

    button.addEventListener('click', (event) => {
        if (suppressNextClick) {
            suppressNextClick = false;
            clearSuppressTimer();
            return;
        }
        triggerInputSelection();
    });

    button.addEventListener('pointerup', (event) => {
        if (event.pointerType === 'touch') {
            event.preventDefault();
            suppressNextClick = true;
            clearSuppressTimer();
            suppressTimerId = window.setTimeout(() => {
                suppressNextClick = false;
                suppressTimerId = null;
            }, 300);
            triggerInputSelection();
        }
    });

    input.addEventListener('change', async () => {
        const file = input.files && input.files[0];
        if (!file) {
            return;
        }

        const label = side === 'you' ? 'You' : 'Me';

        if (file.type && !file.type.startsWith('image/')) {
            const message = `${label} upload failed: selected file is not an image.`;
            console.warn(message);
            showError(message);
            setDescriptionState(side, 'error', message);
            input.value = '';
            return;
        }

        try {
            const dataUrl = await readFileAsDataUrl(file);
            if (typeof dataUrl !== 'string') {
                throw new Error('Uploaded data unavailable.');
            }
            displayPhotoForSide(side, dataUrl);
            stopAllCameras();
            hideError();
        } catch (error) {
            console.error(`${label} photo upload failed:`, error);
            const message = `${label} upload failed: ${error?.message || 'Unable to process image.'}`;
            showError(message);
            setDescriptionState(side, 'error', message);
        } finally {
            input.value = '';
        }
    });
}

export function attachResubmitHandlers(button, side) {
    if (!button) {
        return;
    }
    button.addEventListener('click', () => handleResubmitDescription(side));
    button.addEventListener('touchstart', (event) => {
        event.preventDefault();
        handleResubmitDescription(side);
    }, { passive: false });
}

