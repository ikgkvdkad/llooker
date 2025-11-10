// Main initialization and orchestration - PLACEHOLDER

import { DEFAULT_BACK_ASPECT, DEFAULT_SELFIE_ASPECT } from './config.js';
import * as dom from './dom.js';
import { initializePhotoSlot } from './photo.js';
import { setupSelectionInteractions, updateSelectionStyles } from './selection.js';
import { updateCameraHalfAspect, stopAllCameras } from './camera.js';
import { renderAppVersion } from './ui.js';
import { resetDescriptionState } from './description-api.js';
import { attachUploadHandler, attachResubmitHandlers } from './upload.js';
import { handlePointerDownOnHalf, handlePointerMoveOnHalf, handlePointerUpOnHalf, handlePointerCancelOnHalf } from './interactions.js';

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

    // Setup upload and resubmit handlers
    attachResubmitHandlers(dom.youResubmitButton, 'you');
    attachResubmitHandlers(dom.meResubmitButton, 'me');
    attachUploadHandler(dom.youUploadButton, dom.youUploadInput, 'you');
    attachUploadHandler(dom.meUploadButton, dom.meUploadInput, 'me');
    
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

    // Reset description states
    resetDescriptionState('you');
    resetDescriptionState('me');
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}

