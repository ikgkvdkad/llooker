// Main initialization and orchestration - PLACEHOLDER

import { DEFAULT_BACK_ASPECT, DEFAULT_SELFIE_ASPECT } from './config.js';
import * as dom from './dom.js';
import { initializePhotoSlot } from './photo.js';
import { setupSelectionInteractions, updateSelectionStyles } from './selection.js';
import { updateCameraHalfAspect, stopAllCameras, handleCameraButtonClick, openBackCamera } from './camera.js';
import { renderAppVersion } from './ui.js';
import { resetAnalysisState } from './analysis-api.js';
import { attachUploadHandler, attachReanalyzeHandlers } from './upload.js';
import { handlePointerDownOnHalf, handlePointerMoveOnHalf, handlePointerUpOnHalf, handlePointerCancelOnHalf } from './interactions.js';
import { initHistoryNavigation } from './history.js';
import { handleSimilarityRationaleRequest } from './similarity.js';

/**
 * Initialize the application
 */
function init() {
    // Set default aspect ratios
    updateCameraHalfAspect('back', DEFAULT_BACK_ASPECT);
    updateCameraHalfAspect('selfie', DEFAULT_SELFIE_ASPECT);

    // Setup event listeners for camera interactions
    dom.backCameraHalf.addEventListener('pointerdown', (event) => handlePointerDownOnHalf('back', event));
    dom.backCameraHalf.addEventListener('pointermove', (event) => handlePointerMoveOnHalf('back', event));
    dom.backCameraHalf.addEventListener('pointerup', (event) => handlePointerUpOnHalf('back', event));
    dom.backCameraHalf.addEventListener('pointercancel', (event) => handlePointerCancelOnHalf('back', event));
    dom.backCameraHalf.addEventListener('pointerleave', (event) => handlePointerCancelOnHalf('back', event));

    dom.selfieCameraHalf.addEventListener('pointerdown', (event) => handlePointerDownOnHalf('selfie', event));
    dom.selfieCameraHalf.addEventListener('pointermove', (event) => handlePointerMoveOnHalf('selfie', event));
    dom.selfieCameraHalf.addEventListener('pointerup', (event) => handlePointerUpOnHalf('selfie', event));
    dom.selfieCameraHalf.addEventListener('pointercancel', (event) => handlePointerCancelOnHalf('selfie', event));
    dom.selfieCameraHalf.addEventListener('pointerleave', (event) => handlePointerCancelOnHalf('selfie', event));

    // Cleanup when page is closed
    window.addEventListener('beforeunload', () => {
        stopAllCameras();
    });

    // Setup upload and re-analyze handlers
    attachReanalyzeHandlers(dom.youReanalyzeButton, 'you');
    attachReanalyzeHandlers(dom.meReanalyzeButton, 'me');
    attachUploadHandler(dom.youUploadButton, dom.youUploadInput, 'you');
    attachUploadHandler(dom.meUploadButton, dom.meUploadInput, 'me');
    
    // Setup camera button handlers
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
    
    // Setup selection interactions
    setupSelectionInteractions('back');
    setupSelectionInteractions('selfie');
    updateSelectionStyles('back');
    updateSelectionStyles('selfie');
    
    // Initialize photo slots
    initializePhotoSlot('back');
    initializePhotoSlot('selfie');

    // Render app version
    renderAppVersion();

    // Reset analysis panels
    resetAnalysisState('you');
    resetAnalysisState('me');
    
    // Initialize history navigation
    initHistoryNavigation();

    initSimilarityRationaleModal();
}

let lastFocusedElementBeforeRationale = null;

function handleRationaleKeydown(event) {
    if (event.key === 'Escape') {
        event.preventDefault();
        closeSimilarityRationaleModal();
    }
}

function openSimilarityRationaleModal() {
    if (!dom.similarityRationaleModal) {
        return;
    }
    dom.similarityRationaleModal.classList.add('is-open');
    dom.similarityRationaleModal.setAttribute('aria-hidden', 'false');
    lastFocusedElementBeforeRationale = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    if (dom.similarityRationaleCloseButton) {
        dom.similarityRationaleCloseButton.focus();
    }
    document.addEventListener('keydown', handleRationaleKeydown);
}

function closeSimilarityRationaleModal() {
    if (!dom.similarityRationaleModal) {
        return;
    }
    dom.similarityRationaleModal.classList.remove('is-open');
    dom.similarityRationaleModal.setAttribute('aria-hidden', 'true');
    document.removeEventListener('keydown', handleRationaleKeydown);
    if (lastFocusedElementBeforeRationale && typeof lastFocusedElementBeforeRationale.focus === 'function') {
        lastFocusedElementBeforeRationale.focus();
    }
    lastFocusedElementBeforeRationale = null;
}

function initSimilarityRationaleModal() {
    if (!dom.similarityRationaleButton || !dom.similarityRationaleModal) {
        return;
    }
    dom.similarityRationaleButton.addEventListener('click', () => {
        void handleSimilarityRationaleRequest({
            onRationaleReady: () => openSimilarityRationaleModal()
        });
    });
    if (dom.similarityRationaleOverlay) {
        dom.similarityRationaleOverlay.addEventListener('click', (event) => {
            event.stopPropagation();
            closeSimilarityRationaleModal();
        });
    }
    if (dom.similarityRationaleCloseButton) {
        dom.similarityRationaleCloseButton.addEventListener('click', (event) => {
            event.stopPropagation();
            closeSimilarityRationaleModal();
        });
    }
    // Prevent pointer events on the modal from propagating to camera elements
    if (dom.similarityRationaleModal) {
        dom.similarityRationaleModal.addEventListener('pointerdown', (event) => {
            event.stopPropagation();
        });
        dom.similarityRationaleModal.addEventListener('pointermove', (event) => {
            event.stopPropagation();
        });
        dom.similarityRationaleModal.addEventListener('pointerup', (event) => {
            event.stopPropagation();
        });
    }
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}

