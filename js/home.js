import {
    DEFAULT_BACK_ASPECT,
    DEFAULT_SELFIE_ASPECT,
    CAMERA_SELECTIONS_STORE_URL,
    CAMERA_SELECTIONS_LIST_URL
} from './config.js';
import * as dom from './dom.js';
import { initializePhotoSlot } from './photo.js';
import { setupSelectionInteractions, updateSelectionStyles } from './selection.js';
import { updateCameraHalfAspect, stopAllCameras, handleCameraButtonClick } from './camera.js';
import { attachUploadHandler } from './upload.js';
import {
    handlePointerDownOnHalf,
    handlePointerMoveOnHalf,
    handlePointerUpOnHalf,
    handlePointerCancelOnHalf
} from './interactions.js';
import { snapshotViewportState } from './zoom.js';
import { photoSlots } from './state.js';
import { setAnalysisEnabled, buildViewportSignature, createViewportDataUrl } from './analysis-api.js';
import { renderAppVersion, showError, hideError } from './ui.js';

const SLOT_BY_SIDE = {
    you: 'back',
    me: 'selfie'
};

const galleryStates = [
    dom.galleryLoadingState,
    dom.galleryEmptyState,
    dom.galleryErrorState
];

let isFetchingSelections = false;

function init() {
    setAnalysisEnabled(false);

    updateCameraHalfAspect('back', DEFAULT_BACK_ASPECT);
    updateCameraHalfAspect('selfie', DEFAULT_SELFIE_ASPECT);

    setupPointerInteractions('back', dom.backCameraHalf);
    setupPointerInteractions('selfie', dom.selfieCameraHalf);

    setupSelectionInteractions('back');
    setupSelectionInteractions('selfie');
    updateSelectionStyles('back');
    updateSelectionStyles('selfie');

    initializePhotoSlot('back');
    initializePhotoSlot('selfie');

    attachCameraButtons();
    attachUploaders();
    attachSaveButtons();
    attachRefreshButton();

    window.addEventListener('beforeunload', () => {
        stopAllCameras();
    });

    renderAppVersion();
    void fetchSelections();
}

function setupPointerInteractions(slotKey, element) {
    if (!element) {
        return;
    }
    element.addEventListener('pointerdown', (event) => handlePointerDownOnHalf(slotKey, event));
    element.addEventListener('pointermove', (event) => handlePointerMoveOnHalf(slotKey, event));
    element.addEventListener('pointerup', (event) => handlePointerUpOnHalf(slotKey, event));
    element.addEventListener('pointercancel', (event) => handlePointerCancelOnHalf(slotKey, event));
    element.addEventListener('pointerleave', (event) => handlePointerCancelOnHalf(slotKey, event));
}

function attachCameraButtons() {
    if (dom.youCameraButton) {
        dom.youCameraButton.addEventListener('click', () => handleCameraButtonClick('you'));
        dom.youCameraButton.addEventListener('touchstart', (event) => {
            event.preventDefault();
            handleCameraButtonClick('you');
        }, { passive: false });
    }

    if (dom.meCameraButton) {
        dom.meCameraButton.addEventListener('click', () => handleCameraButtonClick('me'));
        dom.meCameraButton.addEventListener('touchstart', (event) => {
            event.preventDefault();
            handleCameraButtonClick('me');
        }, { passive: false });
    }
}

function attachUploaders() {
    attachUploadHandler(dom.youUploadButton, dom.youUploadInput, 'you');
    attachUploadHandler(dom.meUploadButton, dom.meUploadInput, 'me');
}

function attachSaveButtons() {
    if (dom.youSaveSelectionButton) {
        dom.youSaveSelectionButton.addEventListener('click', () => handleSaveSelection('you'));
    }
    if (dom.meSaveSelectionButton) {
        dom.meSaveSelectionButton.addEventListener('click', () => handleSaveSelection('me'));
    }
}

function attachRefreshButton() {
    if (!dom.refreshSelectionsButton) {
        return;
    }
    dom.refreshSelectionsButton.addEventListener('click', () => {
        void fetchSelections({ force: true });
    });
}

async function handleSaveSelection(side) {
    const button = side === 'you' ? dom.youSaveSelectionButton : dom.meSaveSelectionButton;
    if (!button || button.classList.contains('is-busy')) {
        return;
    }

    const slotKey = SLOT_BY_SIDE[side];
    const slot = slotKey ? photoSlots[slotKey] : null;
    const photoDataUrl = slot?.lastPhotoDataUrl;

    if (!slotKey || !slot || !photoDataUrl) {
        showError(`Capture a ${side === 'you' ? 'You' : 'Me'} photo before saving.`, { diagnostics: false });
        return;
    }

    const viewport = snapshotViewportState(slotKey);
    if (!viewport || !viewport.selection) {
        showError('Selection box is not ready. Adjust the frame and try again.', { diagnostics: false });
        return;
    }

    button.classList.add('is-busy');
    button.disabled = true;

    try {
        const selectionDataUrl = await createViewportDataUrl(photoDataUrl, viewport);
        const signature = buildViewportSignature(photoDataUrl, viewport);
        const payload = {
            role: side,
            imageDataUrl: selectionDataUrl,
            viewport,
            signature,
            capturedAt: new Date().toISOString()
        };

        const response = await fetch(CAMERA_SELECTIONS_STORE_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const errorText = await response.text().catch(() => '');
            throw new Error(errorText || `Failed to store selection (${response.status})`);
        }

        hideError();
        await fetchSelections({ force: true });
    } catch (error) {
        console.error('Failed to store selection:', error);
        showError(`Failed to save selection: ${error?.message || 'Unknown error'}`, { diagnostics: false });
    } finally {
        button.classList.remove('is-busy');
        button.disabled = false;
    }
}

function setGalleryState(target) {
    galleryStates.forEach((stateEl) => {
        if (!stateEl) {
            return;
        }
        stateEl.classList.toggle('is-visible', stateEl === target);
    });
}

function clearGalleryStates() {
    galleryStates.forEach(stateEl => stateEl?.classList.remove('is-visible'));
}

async function fetchSelections({ force = false } = {}) {
    if (isFetchingSelections && !force) {
        return;
    }
    if (!dom.galleryList) {
        return;
    }

    isFetchingSelections = true;
    if (dom.galleryLoadingState) {
        dom.galleryLoadingState.textContent = 'Loading selections…';
        setGalleryState(dom.galleryLoadingState);
    }

    try {
        const response = await fetch(`${CAMERA_SELECTIONS_LIST_URL}?limit=100`);
        if (!response.ok) {
            const errorText = await response.text().catch(() => '');
            throw new Error(errorText || `Failed to load selections (${response.status})`);
        }
        const payload = await response.json();
        const items = Array.isArray(payload?.selections) ? payload.selections : [];
        renderGalleryList(items);
        if (!items.length) {
            setGalleryState(dom.galleryEmptyState);
        } else {
            clearGalleryStates();
        }
    } catch (error) {
        console.error('Failed to fetch selections:', error);
        if (dom.galleryErrorState) {
            dom.galleryErrorState.textContent = error?.message || 'Failed to load saved selections.';
            setGalleryState(dom.galleryErrorState);
        }
    } finally {
        isFetchingSelections = false;
    }
}

function renderGalleryList(items) {
    if (!dom.galleryList) {
        return;
    }
    dom.galleryList.innerHTML = '';
    items.forEach((item) => {
        const listItem = document.createElement('li');
        listItem.className = 'gallery-row';

        const thumbnail = document.createElement('img');
        thumbnail.className = 'gallery-thumbnail';
        thumbnail.src = item.imageDataUrl;
        thumbnail.alt = `${(item.role || 'unknown').toUpperCase()} selection`;

        const meta = document.createElement('div');
        meta.className = 'gallery-row-meta';

        const timestamp = document.createElement('span');
        timestamp.className = 'gallery-row-time';
        timestamp.textContent = formatTimestamp(item.createdAt || item.capturedAt);

        meta.appendChild(timestamp);
        listItem.appendChild(thumbnail);
        listItem.appendChild(meta);
        dom.galleryList.appendChild(listItem);
    });
}

function formatTimestamp(raw) {
    if (!raw) {
        return 'Unknown time';
    }
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) {
        return 'Unknown time';
    }
    const diffMs = Date.now() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins} min ago`;
    if (diffHours < 24) return diffHours === 1 ? '1 hour ago' : `${diffHours} hours ago`;
    if (diffDays < 7) return diffDays === 1 ? 'Yesterday' : `${diffDays} days ago`;
    return date.toLocaleString();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
