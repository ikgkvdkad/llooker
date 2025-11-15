// Single-camera page initialization and selection storage

import { DEFAULT_BACK_ASPECT, SINGLE_SELECTIONS_STORE_URL, SINGLE_SELECTIONS_LIST_URL, SINGLE_SELECTIONS_CLEAR_URL } from './config.js';
import * as dom from './dom.js';
import { initializePhotoSlot, displayPhotoForSide } from './photo.js';
import { setupSelectionInteractions, updateSelectionStyles } from './selection.js';
import { updateCameraHalfAspect, stopAllCameras, handleCameraButtonClick, isCameraActive } from './camera.js';
import { renderAppVersion, showError, showWarning } from './ui.js';
import { snapshotViewportState } from './zoom.js';
import { photoSlots } from './state.js';
import { createViewportDataUrl, buildViewportSignature } from './analysis-api.js';
import { readFileAsDataUrl } from './utils.js';
import {
    handlePointerDownOnHalf,
    handlePointerMoveOnHalf,
    handlePointerUpOnHalf,
    handlePointerCancelOnHalf
} from './interactions.js';

function assertConfigured(value, message) {
    if (!value) {
        showError(message, { diagnostics: false });
        throw new Error(message);
    }
}

function getSingleSelectionContainer() {
    if (!dom.galleryList) {
        // Single page has its own container
        const el = document.getElementById('singleSelectionList');
        if (!el) {
            console.warn('Single selection list container missing.');
        }
        return el;
    }
    return document.getElementById('singleSelectionList');
}

function renderSelectionRow(selection) {
    const container = getSingleSelectionContainer();
    if (!container || !selection?.imageDataUrl) {
        return;
    }

    const row = document.createElement('div');
    row.className = 'single-selection-row';

    const wrapper = document.createElement('div');
    wrapper.className = 'single-selection-thumb-wrapper';

    const img = document.createElement('img');
    img.className = 'single-selection-thumb';
    img.src = selection.imageDataUrl;
    img.alt = 'Saved selection';
    img.loading = 'lazy';

    wrapper.appendChild(img);

    if (selection.capturedAt || selection.createdAt) {
        const meta = document.createElement('div');
        meta.className = 'single-selection-meta';
        const timestamp = selection.capturedAt || selection.createdAt;
        meta.textContent = timestamp ? new Date(timestamp).toLocaleString() : '';
        wrapper.appendChild(meta);
    }

    row.appendChild(wrapper);
    container.appendChild(row);
}

async function loadExistingSelections() {
    if (!SINGLE_SELECTIONS_LIST_URL) {
        // Missing configuration should be explicit, no silent fallbacks
        showWarning('Single selections API (list) is not configured. Saved thumbnails will not load.', {
            diagnostics: false
        });
        return;
    }

    try {
        const response = await fetch(`${SINGLE_SELECTIONS_LIST_URL}?limit=200&offset=0`);
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        const payload = await response.json();
        const selections = Array.isArray(payload?.selections) ? payload.selections : [];

        const container = getSingleSelectionContainer();
        if (!container) {
            return;
        }
        container.innerHTML = '';

        selections.forEach((selection) => {
            renderSelectionRow(selection);
        });
    } catch (error) {
        console.error('Failed to load single-camera selections:', error);
        showWarning('Unable to load previously saved selections.', {
            diagnostics: false,
            detail: error?.message || null
        });
    }
}

async function saveCurrentSelection() {
    assertConfigured(
        SINGLE_SELECTIONS_STORE_URL,
        'Single selections API (store) is not configured.'
    );

    const slot = photoSlots.back;
    if (!slot || typeof slot.lastPhotoDataUrl !== 'string' || !slot.lastPhotoDataUrl.length) {
        showWarning('Capture a photo before saving a selection.', { diagnostics: false });
        return;
    }

    const viewport = snapshotViewportState('back');
    if (!viewport) {
        showWarning('Viewing area is still stabilizing. Adjust the frame and try saving again.', {
            diagnostics: false
        });
        return;
    }

    // For the single page we treat the zoomed view as the selection:
    // always use the full viewport, no visible selection box.
    const viewportForSave = {
        ...viewport,
        selection: {
            x: 0,
            y: 0,
            width: 1,
            height: 1
        }
    };

    let croppedDataUrl;
    try {
        croppedDataUrl = await createViewportDataUrl(slot.lastPhotoDataUrl, viewportForSave);
    } catch (error) {
        console.error('Failed to render viewport for single selection:', error);
        showError('Failed to render the selected area for saving.', {
            diagnostics: false,
            detail: error?.message || null
        });
        return;
    }

    const signature = buildViewportSignature(slot.lastPhotoDataUrl, viewportForSave);
    const capturedAtIso = new Date().toISOString();

    const payload = {
        imageDataUrl: croppedDataUrl,
        viewport: viewportForSave,
        signature,
        capturedAt: capturedAtIso,
        mode: 'single'
    };

    try {
        const response = await fetch(SINGLE_SELECTIONS_STORE_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const errorText = await response.text().catch(() => '');
            throw new Error(errorText || `HTTP ${response.status}`);
        }

        const result = await response.json().catch(() => ({}));
        const selectionMeta = result?.selection || {};

        renderSelectionRow({
            imageDataUrl: croppedDataUrl,
            createdAt: selectionMeta.createdAt || null,
            capturedAt: selectionMeta.capturedAt || capturedAtIso
        });
    } catch (error) {
        console.error('Failed to store single-camera selection:', error);
        showError('Failed to save selection. Check diagnostics and try again.', {
            diagnostics: false,
            detail: error?.message || null
        });
    }
}

async function clearAllSelections() {
    assertConfigured(
        SINGLE_SELECTIONS_CLEAR_URL,
        'Single selections API (clear) is not configured.'
    );

    try {
        const response = await fetch(SINGLE_SELECTIONS_CLEAR_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            const errorText = await response.text().catch(() => '');
            throw new Error(errorText || `HTTP ${response.status}`);
        }

        const container = getSingleSelectionContainer();
        if (container) {
            container.innerHTML = '';
        }
    } catch (error) {
        console.error('Failed to clear single-camera selections:', error);
        showError('Failed to clear selections. Check diagnostics and try again.', {
            diagnostics: false,
            detail: error?.message || null
        });
    }
}

async function handleSingleUpload(fileInput) {
    const file = fileInput.files && fileInput.files[0];
    if (!file) {
        return;
    }

    const label = 'Subject';

    if (file.type && !file.type.startsWith('image/')) {
        const message = `${label} upload failed: selected file is not an image.`;
        console.warn(message);
        showError(message, { diagnostics: false });
        fileInput.value = '';
        return;
    }

    try {
        const dataUrl = await readFileAsDataUrl(file);
        if (typeof dataUrl !== 'string' || !dataUrl.length) {
            throw new Error('Uploaded image data unavailable.');
        }
        // Reuse existing display pipeline for the "you"/back slot
        displayPhotoForSide('you', dataUrl);
        stopAllCameras();
    } catch (error) {
        console.error(`${label} photo upload failed (single page):`, error);
        const message = `${label} upload failed: ${error?.message || 'Unable to process image.'}`;
        showError(message, {
            diagnostics: false,
            detail: error?.stack || null
        });
    } finally {
        fileInput.value = '';
    }
}

function attachSingleUploadHandler(button, input) {
    if (!button || !input) {
        showWarning('Upload controls missing on single camera page.', { diagnostics: false });
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

    input.addEventListener('change', () => {
        void handleSingleUpload(input);
    });
}

function openSingleCameraModal() {
    const modal = document.getElementById('singleCameraModal');
    if (!modal) {
        showError('Single camera modal missing in DOM.', { diagnostics: false });
        return;
    }
    modal.classList.add('is-open');
    modal.setAttribute('aria-hidden', 'false');
}

function closeSingleCameraModal() {
    const modal = document.getElementById('singleCameraModal');
    if (!modal) {
        return;
    }
    modal.classList.remove('is-open');
    modal.setAttribute('aria-hidden', 'true');
    // Reset camera slot after closing
    initializePhotoSlot('back');
    stopAllCameras();
}

function attachCameraModalHandlers() {
    const modal = document.getElementById('singleCameraModal');
    const overlay = document.getElementById('singleCameraOverlay');

    if (overlay && modal) {
        overlay.addEventListener('click', () => {
            closeSingleCameraModal();
        });
    }

    const cameraButton = dom.youCameraButton;
    if (cameraButton) {
        cameraButton.addEventListener('click', async () => {
            const wasActive = isCameraActive('back');
            handleCameraButtonClick('you');

            // If camera was already active, this click captured a frame.
            if (wasActive) {
                // Allow capture pipeline to update photoSlots, then save and close.
                window.setTimeout(async () => {
                    await saveCurrentSelection();
                    closeSingleCameraModal();
                }, 0);
            }
        });
    }
}

function initSinglePage() {
    // Set default aspect ratio for back camera
    updateCameraHalfAspect('back', DEFAULT_BACK_ASPECT);

    // Pointer interactions for zoom/pan (within modal)
    if (dom.backCameraHalf) {
        dom.backCameraHalf.addEventListener('pointerdown', (event) => handlePointerDownOnHalf('back', event));
        dom.backCameraHalf.addEventListener('pointermove', (event) => handlePointerMoveOnHalf('back', event));
        dom.backCameraHalf.addEventListener('pointerup', (event) => handlePointerUpOnHalf('back', event));
        dom.backCameraHalf.addEventListener('pointercancel', (event) => handlePointerCancelOnHalf('back', event));
        dom.backCameraHalf.addEventListener('pointerleave', (event) => handlePointerCancelOnHalf('back', event));
    }

    // Cleanup cameras on unload
    window.addEventListener('beforeunload', () => {
        stopAllCameras();
    });

    // Selection interactions for the single slot
    setupSelectionInteractions('back');
    updateSelectionStyles('back');
    initializePhotoSlot('back');

    // Camera modal handlers
    attachCameraModalHandlers();

    // Toolbar camera open button
    const openCameraButton = document.getElementById('singleOpenCameraButton');
    if (openCameraButton) {
        openCameraButton.addEventListener('click', () => {
            openSingleCameraModal();
            // First click on modal camera button will start camera
        });
    }

    // Upload button behavior (single page variant)
    const uploadButton = document.getElementById('youUploadButton');
    const uploadInput = document.getElementById('youUploadInput');
    attachSingleUploadHandler(uploadButton, uploadInput);

    // Clear-all button
    const clearButton = document.getElementById('singleClearButton');
    if (clearButton) {
        clearButton.addEventListener('click', () => {
            void clearAllSelections();
        });
    }

    // Render version badge
    renderAppVersion();

    // Load existing selections for this collection
    void loadExistingSelections();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initSinglePage);
} else {
    initSinglePage();
}


