// Single-camera page initialization and selection storage

import { DEFAULT_BACK_ASPECT, SINGLE_SELECTIONS_STORE_URL, SINGLE_SELECTIONS_LIST_URL, SINGLE_SELECTIONS_CLEAR_URL } from './config.js';
import * as dom from './dom.js';
import { initializePhotoSlot, displayPhotoForSide } from './photo.js';
import { setupSelectionInteractions, updateSelectionStyles } from './selection.js';
import { updateCameraHalfAspect, stopAllCameras, openBackCamera, captureBackPhoto } from './camera.js';
import { renderAppVersion, showError, showWarning } from './ui.js';
import { snapshotViewportState } from './zoom.js';
import { photoSlots } from './state.js';
import { createViewportDataUrl, buildViewportSignature } from './analysis-api.js';
import { readFileAsDataUrl, loadImageElement } from './utils.js';
import {
    handlePointerDownOnHalf,
    handlePointerMoveOnHalf,
    handlePointerUpOnHalf,
    handlePointerCancelOnHalf,
    registerTapHandler
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

const singleGroupRows = new Map();

function buildDescriptionGroupKey(description) {
    if (typeof description !== 'string') {
        return null;
    }

    const normalized = description
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\b(?:the|a|an|and|with|wearing|holding|carrying|while)\b/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    if (!normalized) {
        return null;
    }

    // Simple deterministic hash so similar descriptions map together.
    let hash = 0;
    for (let i = 0; i < normalized.length; i += 1) {
        hash = (hash * 31 + normalized.charCodeAt(i)) >>> 0;
    }

    return `desc-${normalized.slice(0, 48)}-${hash.toString(16)}`;
}

async function buildFullFrameViewportSnapshot(photoDataUrl) {
    const image = await loadImageElement(photoDataUrl);
    const naturalWidth = image?.naturalWidth || image?.width || 0;
    const naturalHeight = image?.naturalHeight || image?.height || 0;

    if (!naturalWidth || !naturalHeight) {
        throw new Error('Uploaded photo dimensions unavailable.');
    }

    const devicePixelRatio = window.devicePixelRatio && Number.isFinite(window.devicePixelRatio)
        ? Math.max(1, window.devicePixelRatio)
        : 1;

    return {
        containerWidth: naturalWidth,
        containerHeight: naturalHeight,
        naturalWidth,
        naturalHeight,
        objectFit: 'contain',
        transform: {
            scale: 1,
            translateX: 0,
            translateY: 0
        },
        devicePixelRatio,
        selection: {
            x: 0,
            y: 0,
            width: 1,
            height: 1
        }
    };
}

function renderSelectionRow(selection) {
    const container = getSingleSelectionContainer();
    if (!container || !selection?.imageDataUrl) {
        return;
    }

    const descriptionKey = buildDescriptionGroupKey(selection.description);
    let groupKey;
    if (selection.personGroupId) {
        groupKey = `group-${selection.personGroupId}`;
    } else if (descriptionKey) {
        groupKey = descriptionKey;
    } else if (selection.id) {
        groupKey = `selection-${selection.id}`;
        console.warn('Selection missing grouping metadata; falling back to unique row.', selection);
    } else {
        groupKey = `selection-${crypto.randomUUID?.() || Math.random()}`;
        console.warn('Selection missing grouping metadata and id; using random row key.', selection);
    }

    let row = singleGroupRows.get(groupKey);
    if (!row) {
        row = document.createElement('div');
        row.className = 'single-selection-row';
        row.dataset.groupKey = groupKey;
        row.dataset.groupSource = selection.personGroupId ? 'personGroupId' : descriptionKey ? 'description' : 'selectionId';
        singleGroupRows.set(groupKey, row);
        container.appendChild(row);
    }

    const wrapper = document.createElement('div');
    wrapper.className = 'single-selection-thumb-wrapper';
    if (selection.description && selection.description.length > 0) {
        wrapper.classList.add('has-description');
    }
    if (selection.id) {
        wrapper.dataset.selectionId = String(selection.id);
    }
    wrapper.dataset.description = selection.description || '';

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

    const openDescription = async () => {
        const modal = document.getElementById('singleDescriptionModal');
        const textEl = document.getElementById('singleDescriptionText');

        if (!modal || !textEl) {
            showWarning('Description viewer unavailable. Reload the page and try again.', {
                diagnostics: false
            });
            return;
        }

        let description = wrapper.dataset.description || '';
        const selectionId = wrapper.dataset.selectionId ? Number(wrapper.dataset.selectionId) : null;

        const needsRefresh = !description || description.length < 400;

        if (needsRefresh && selectionId) {
            try {
                const response = await fetch('/.netlify/functions/update-single-description', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ id: selectionId })
                });

                if (!response.ok) {
                    const errorText = await response.text().catch(() => '');
                    throw new Error(errorText || `HTTP ${response.status}`);
                }

                const payload = await response.json().catch(() => ({}));
                if (payload && payload.groupingDebug) {
                    console.log('single-page grouping (refresh)', payload.groupingDebug);
                }
                    if (payload && typeof payload.description === 'string' && payload.description.trim().length) {
                        description = payload.description.trim();
                        wrapper.dataset.description = description;
                        wrapper.classList.add('has-description');
                    } else {
                    showWarning('Description generation did not return usable text. Try capturing a new photo.', {
                        diagnostics: false
                    });
                }
            } catch (error) {
                console.error('Failed to refresh description for this photo:', error);
                showError('Failed to refresh description for this photo. Check diagnostics and try again.', {
                    diagnostics: false,
                    detail: error?.message || null
                });
            }
        }

        if (!description) {
            showWarning('Description not available for this photo. Capture a new photo to generate one.', {
                diagnostics: false
            });
            return;
        }

        textEl.textContent = description;
        modal.classList.add('is-open');
        modal.setAttribute('aria-hidden', 'false');
    };
    wrapper.addEventListener('click', () => {
        void openDescription();
    });
    wrapper.addEventListener('touchstart', (event) => {
        event.preventDefault();
        void openDescription();
    }, { passive: false });
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
        singleGroupRows.clear();

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

async function saveCurrentSelection({ viewportOverride = null } = {}) {
    assertConfigured(
        SINGLE_SELECTIONS_STORE_URL,
        'Single selections API (store) is not configured.'
    );

    const slot = photoSlots.back;
    if (!slot || typeof slot.lastPhotoDataUrl !== 'string' || !slot.lastPhotoDataUrl.length) {
        showWarning('Capture a photo before saving a selection.', { diagnostics: false });
        return;
    }

    const viewport = viewportOverride || snapshotViewportState('back');
    if (!viewport) {
        const message = viewportOverride
            ? 'Uploaded photo is still loading. Wait a moment and try again.'
            : 'Viewing area is still stabilizing. Adjust the frame and try saving again.';
        showWarning(message, { diagnostics: false });
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
        if (result && result.groupingDebug) {
            console.log('single-page grouping (save)', result.groupingDebug);
        }
        const selectionMeta = result?.selection || {};

        renderSelectionRow({
            id: selectionMeta.id || null,
            personGroupId: selectionMeta.personGroupId || null,
            imageDataUrl: croppedDataUrl,
            createdAt: selectionMeta.createdAt || null,
            capturedAt: selectionMeta.capturedAt || capturedAtIso,
            description: selectionMeta.description || ''
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
        const viewportOverride = await buildFullFrameViewportSnapshot(dataUrl);
        await saveCurrentSelection({ viewportOverride });
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

    document.body.classList.add('single-camera-active');

    modal.classList.add('is-open');
    modal.setAttribute('aria-hidden', 'false');

    const fullscreenTarget = modal.querySelector('.camera-container') || modal;
    if (fullscreenTarget && typeof fullscreenTarget.requestFullscreen === 'function') {
        fullscreenTarget.requestFullscreen().catch((error) => {
            console.warn('Fullscreen camera request failed:', error);
        });
    } else {
        console.warn('Fullscreen API not available for single camera modal.');
    }

    // Try to start the back camera immediately so the first tap captures
    openBackCamera().catch(error => {
        console.error('Failed to open back camera (single page):', error);
        showError('Failed to open back camera. Check camera permissions and try again.', {
            diagnostics: false,
            detail: error?.message || null
        });
    });
}

function closeSingleCameraModal() {
    const modal = document.getElementById('singleCameraModal');
    if (!modal) {
        return;
    }
    modal.classList.remove('is-open');
    modal.setAttribute('aria-hidden', 'true');

    document.body.classList.remove('single-camera-active');

    if (document.fullscreenElement && typeof document.exitFullscreen === 'function') {
        document.exitFullscreen().catch((error) => {
            console.warn('Exiting fullscreen failed:', error);
        });
    }
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

    const descriptionModal = document.getElementById('singleDescriptionModal');
    const descriptionOverlay = document.getElementById('singleDescriptionOverlay');
    if (descriptionOverlay && descriptionModal) {
        descriptionOverlay.addEventListener('click', () => {
            descriptionModal.classList.remove('is-open');
            descriptionModal.setAttribute('aria-hidden', 'true');
        });
    }

    // Use tap gestures on the camera half to start/capture instead of a visible button
    registerTapHandler('back', ({ isActive }) => {
        const cameraModal = document.getElementById('singleCameraModal');
        if (!cameraModal || !cameraModal.classList.contains('is-open')) {
            // Not in single camera modal context; fall back to default behavior.
            return false;
        }

        // When the camera modal is open we treat any tap as capture:
        // camera should already be active from openSingleCameraModal.
        if (isActive) {
            captureBackPhoto();
            window.setTimeout(() => {
                void saveCurrentSelection();
                closeSingleCameraModal();
            }, 0);
            return true;
        }

        return false;
    });
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
            // Camera will start on first tap inside the modal
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


