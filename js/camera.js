// Camera lifecycle and control - COMPLETE VERSION
// To use: rename this to camera.js after review

import { BACK_TARGET_ZOOM, SELFIE_ZOOM_MODE, CAMERA_RELEASE_TIMEOUT_MS } from './config.js';
import * as dom from './dom.js';
import { cameraLayoutState, interactionState, getBackStream, getSelfieStream, getIsBackActive, getIsSelfieActive, getIsBackFrozen, getIsSelfieFrozen, getIsOpeningBackCamera, getIsOpeningSelfieCamera, getBackInitializationTimeoutId, setBackStream, setSelfieStream, setIsBackActive, setIsSelfieActive, setIsBackFrozen, setIsSelfieFrozen, setIsOpeningBackCamera, setIsOpeningSelfieCamera, setBackInitializationTimeoutId } from './state.js';
import { initializePhotoSlot, prepareSlotForLiveView, displayPhotoForSide } from './photo.js';
import { showError, showWarning, hideError } from './ui.js';
import { initializeZoomStateFromTrack, clearMovementDebounce } from './zoom.js';
import { resetPointerTracking } from './interactions.js';
import { resetDescriptionState } from './description-api.js';

/**
 * Get camera half element
 */
export function getCameraHalfElement(slotKey) {
    if (slotKey === 'back') {
        return dom.backCameraHalf;
    }
    if (slotKey === 'selfie') {
        return dom.selfieCameraHalf;
    }
    return null;
}

/**
 * Check camera status functions
 */
export function isCameraActive(slotKey) {
    if (slotKey === 'back') {
        return getIsBackActive();
    }
    if (slotKey === 'selfie') {
        return getIsSelfieActive();
    }
    return false;
}

export function isCameraFrozen(slotKey) {
    if (slotKey === 'back') {
        return getIsBackFrozen();
    }
    if (slotKey === 'selfie') {
        return getIsSelfieFrozen();
    }
    return false;
}

/**
 * Update camera half aspect ratio
 */
export function updateCameraHalfAspect(side, aspectRatio) {
    const state = cameraLayoutState[side];
    if (!state || !state.element) {
        return;
    }

    if (typeof aspectRatio === 'number' && isFinite(aspectRatio) && aspectRatio > 0) {
        state.aspectRatio = aspectRatio;
        state.element.dataset.cameraAspect = aspectRatio.toString();
        state.element.style.setProperty('--camera-aspect', aspectRatio);
    } else {
        state.aspectRatio = null;
        delete state.element.dataset.cameraAspect;
        state.element.style.removeProperty('--camera-aspect');
    }
}

/**
 * Stream utilities
 */
function stopStream(stream) {
    if (!stream) {
        return;
    }
    stream.getTracks().forEach(track => track.stop());
}

function waitForTrackToEnd(track, timeoutMs = CAMERA_RELEASE_TIMEOUT_MS) {
    if (!track || track.readyState === 'ended') {
        return Promise.resolve();
    }

    return new Promise(resolve => {
        const cleanup = () => {
            track.removeEventListener('ended', handleEnded);
            window.clearTimeout(timerId);
            resolve();
        };

        const handleEnded = () => {
            cleanup();
        };

        const timerId = window.setTimeout(cleanup, timeoutMs);
        track.addEventListener('ended', handleEnded, { once: true });
    });
}

async function stopAllCamerasAndWait(timeoutMs = CAMERA_RELEASE_TIMEOUT_MS) {
    const tracks = [];

    const backStream = getBackStream();
    const selfieStream = getSelfieStream();

    if (backStream) {
        tracks.push(...backStream.getTracks());
    }

    if (selfieStream) {
        tracks.push(...selfieStream.getTracks());
    }

    stopAllCameras();

    if (!tracks.length) {
        return;
    }

    await Promise.all(tracks.map(track => waitForTrackToEnd(track, timeoutMs)));
}

/**
 * Check camera support
 */
function checkCameraSupport() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        showError('Camera API is not supported in this browser.');
        return false;
    }
    return true;
}

/**
 * Stop all cameras
 */
export function stopAllCameras() {
    const backStream = getBackStream();
    const selfieStream = getSelfieStream();
    
    // Stop back camera
    if (backStream) {
        stopStream(backStream);
        setBackStream(null);
    }
    dom.backVideoElement.srcObject = null;
    dom.backVideoElement.classList.remove('active');
    dom.backCameraHalf.classList.remove('initializing');
    setIsBackActive(false);
    resetPointerTracking('back');
    const backState = interactionState.back;
    if (backState) {
        backState.zoomSupported = false;
        backState.streamZoom.min = 1;
        backState.streamZoom.max = 1;
        backState.streamZoom.current = 1;
        backState.lastSubmittedSignature = null;
    }

    const backTimeoutId = getBackInitializationTimeoutId();
    if (backTimeoutId !== null) {
        clearTimeout(backTimeoutId);
        setBackInitializationTimeoutId(null);
    }
    
    // Stop selfie camera
    if (selfieStream) {
        stopStream(selfieStream);
        setSelfieStream(null);
    }
    dom.selfieVideoElement.srcObject = null;
    dom.selfieVideoElement.classList.remove('active');
    setIsSelfieActive(false);
    resetPointerTracking('selfie');
    const selfieState = interactionState.selfie;
    if (selfieState) {
        selfieState.zoomSupported = false;
        selfieState.streamZoom.min = 1;
        selfieState.streamZoom.max = 1;
        selfieState.streamZoom.current = 1;
        selfieState.lastSubmittedSignature = null;
    }
    
    if (!getIsBackFrozen()) {
        initializePhotoSlot('back');
    }

    if (!getIsSelfieFrozen()) {
        initializePhotoSlot('selfie');
    }
}

/**
 * Apply zoom setting to stream
 */
async function applyZoomSetting(stream, targetZoom) {
    const track = stream?.getVideoTracks()[0];

    if (!track) {
        return { success: false, reason: 'No video track available.' };
    }

    if (typeof track.getCapabilities !== 'function') {
        const warning = 'Zoom capability is not available on this device.';
        console.warn(warning);
        return { success: true, appliedZoom: null, warning };
    }

    const capabilities = track.getCapabilities();
    const zoomCapabilities = capabilities?.zoom;

    if (!zoomCapabilities) {
        const warning = 'Zoom control is not supported for this camera.';
        console.warn(warning);
        return { success: true, appliedZoom: null, warning };
    }

    const { min, max } = zoomCapabilities;

    if (typeof min !== 'number' || typeof max !== 'number') {
        const warning = 'Zoom range information is unavailable for this camera.';
        console.warn(warning);
        return { success: true, appliedZoom: null, warning };
    }

    let desiredZoom;

    if (targetZoom === 'min') {
        desiredZoom = min;
    } else if (targetZoom === 'max') {
        desiredZoom = max;
    } else if (typeof targetZoom === 'number') {
        desiredZoom = Math.min(max, Math.max(min, targetZoom));
        if (targetZoom > max + 1e-3) {
            return { success: false, reason: `Requested zoom ${targetZoom}x exceeds supported maximum ${max.toFixed(2)}x.` };
        }
    } else {
        return { success: false, reason: 'Invalid zoom configuration requested.' };
    }

    try {
        await track.applyConstraints({ advanced: [{ zoom: desiredZoom }] });
        return { success: true, appliedZoom: desiredZoom };
    } catch (primaryError) {
        try {
            await track.applyConstraints({ zoom: desiredZoom });
            return { success: true, appliedZoom: desiredZoom };
        } catch (secondaryError) {
            const fallbackError = secondaryError || primaryError;
            return { success: false, reason: fallbackError?.message || 'Unable to adjust zoom for this camera.' };
        }
    }
}

/**
 * Wait for zoom to settle
 */
async function waitForZoomToSettle(track, targetZoom, tolerance = 0.05, timeoutMs = 1500) {
    if (!track || typeof track.getSettings !== 'function') {
        return { success: false, reason: 'Zoom settings cannot be read for this camera.' };
    }

    if (typeof targetZoom !== 'number') {
        return { success: false, reason: 'Invalid target zoom provided.' };
    }

    const startTime = performance.now();

    while (performance.now() - startTime < timeoutMs) {
        const settings = track.getSettings();
        if (settings && typeof settings.zoom === 'number') {
            const currentZoom = settings.zoom;
            if (Math.abs(currentZoom - targetZoom) <= tolerance) {
                return { success: true, appliedZoom: currentZoom };
            }
        }
        await new Promise(resolve => setTimeout(resolve, 50));
    }

    const finalSettings = track.getSettings?.();
    const reportedZoom = typeof finalSettings?.zoom === 'number'
        ? finalSettings.zoom.toFixed(2) + 'x'
        : 'an unknown level';

    return {
        success: false,
        reason: `Camera never reported ${targetZoom.toFixed(2)}x zoom (last reported ${reportedZoom}).`
    };
}

/**
 * Wait for video metadata
 */
function waitForVideoMetadata(videoElement) {
    if (videoElement.readyState >= HTMLMediaElement.HAVE_METADATA) {
        return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
        const handleLoaded = () => {
            videoElement.removeEventListener('error', handleError);
            resolve();
        };

        const handleError = (event) => {
            videoElement.removeEventListener('loadedmetadata', handleLoaded);
            reject(event?.error || new Error('Failed to load camera metadata.'));
        };

        videoElement.addEventListener('loadedmetadata', handleLoaded, { once: true });
        videoElement.addEventListener('error', handleError, { once: true });
    });
}

/**
 * Activate back camera stream
 */
async function activateBackStream(stream) {
    const zoomResult = await applyZoomSetting(stream, BACK_TARGET_ZOOM);
    if (!zoomResult.success) {
        stopStream(stream);
        showError('Back camera (requires 2x zoom): ' + zoomResult.reason);
        return false;
    }

    const track = stream.getVideoTracks()[0];
    initializeZoomStateFromTrack('back', track);

    setBackStream(stream);
    dom.backVideoElement.srcObject = stream;

    try {
        const shouldVerifyZoom = typeof zoomResult.appliedZoom === 'number';
        const expectedZoom = shouldVerifyZoom
            ? zoomResult.appliedZoom
            : BACK_TARGET_ZOOM;

        const zoomVerificationPromise = shouldVerifyZoom
            ? waitForZoomToSettle(track, expectedZoom)
            : Promise.resolve({ success: true, appliedZoom: zoomResult.appliedZoom });

        const [zoomSettled] = await Promise.all([
            zoomVerificationPromise,
            waitForVideoMetadata(dom.backVideoElement)
        ]);

        if (shouldVerifyZoom && !zoomSettled.success) {
            stopStream(stream);
            dom.backVideoElement.srcObject = null;
            showError('Back camera (requires 2x zoom): ' + zoomSettled.reason);
            return false;
        }

        if (shouldVerifyZoom) {
            const verifiedZoom = typeof zoomSettled.appliedZoom === 'number'
                ? zoomSettled.appliedZoom
                : (typeof track.getSettings === 'function' ? track.getSettings().zoom : undefined);

            if (typeof verifiedZoom === 'number' && Math.abs(verifiedZoom - expectedZoom) > 0.05) {
                stopStream(stream);
                dom.backVideoElement.srcObject = null;
                showError('Back camera (requires 2x zoom): Device reported ' + verifiedZoom.toFixed(2) + 'x zoom.');
                return false;
            }
            const backState = interactionState.back;
            if (backState) {
                backState.streamZoom.current = typeof verifiedZoom === 'number' ? verifiedZoom : expectedZoom;
            }
        } else if (typeof zoomResult.appliedZoom === 'number') {
            const backState = interactionState.back;
            if (backState) {
                backState.streamZoom.current = zoomResult.appliedZoom;
            }
        }

        const videoWidth = dom.backVideoElement.videoWidth;
        const videoHeight = dom.backVideoElement.videoHeight;
        if (videoWidth && videoHeight) {
            updateCameraHalfAspect('back', videoWidth / videoHeight);
        } else {
            console.warn('Back camera metadata unavailable after initialization.');
        }
    } catch (error) {
        console.error('Back camera stream failed to become ready:', error);
        stopStream(stream);
        dom.backVideoElement.srcObject = null;
        showError('Back camera (requires 2x zoom): Unable to load camera stream.');
        return false;
    }

    if (zoomResult.warning) {
        showWarning('Back camera: ' + zoomResult.warning + ' Displaying the default field of view.');
    } else {
        hideError();
    }
    dom.backCameraHalf.classList.add('initializing');
    prepareSlotForLiveView('back');
    dom.backVideoElement.classList.add('active');
    const backState = interactionState.back;
    if (backState) {
        backState.lastTap = null;
        backState.lastSubmittedSignature = null;
        clearMovementDebounce('back');
    }
    setIsBackActive(true);
    dom.backPlaceholder.classList.add('hidden');

    const backTimeoutId = getBackInitializationTimeoutId();
    if (backTimeoutId !== null) {
        clearTimeout(backTimeoutId);
    }

    const timeoutId = window.setTimeout(() => {
        dom.backCameraHalf.classList.remove('initializing');
        setBackInitializationTimeoutId(null);
    }, 1000);
    setBackInitializationTimeoutId(timeoutId);

    return true;
}

/**
 * Activate selfie camera stream
 */
async function activateSelfieStream(stream) {
    setSelfieStream(stream);
    dom.selfieVideoElement.srcObject = stream;
    const selfieTrack = stream?.getVideoTracks()[0];

    const zoomResult = await applyZoomSetting(stream, SELFIE_ZOOM_MODE);
    if (!zoomResult.success) {
        stopStream(stream);
        setSelfieStream(null);
        dom.selfieVideoElement.srcObject = null;
        showError('Selfie camera: ' + zoomResult.reason);
        return false;
    }
    initializeZoomStateFromTrack('selfie', selfieTrack);

    let zoomWarningMessage = zoomResult.warning
        ? 'Selfie camera: ' + zoomResult.warning + ' Displaying the default field of view.'
        : null;

    try {
        const shouldVerifyZoom = typeof zoomResult.appliedZoom === 'number';
        const expectedZoom = shouldVerifyZoom
            ? zoomResult.appliedZoom
            : undefined;

        const zoomVerificationPromise = shouldVerifyZoom
            ? waitForZoomToSettle(selfieTrack, expectedZoom)
            : Promise.resolve({ success: true, appliedZoom: zoomResult.appliedZoom });

        const [zoomSettled] = await Promise.all([
            zoomVerificationPromise,
            waitForVideoMetadata(dom.selfieVideoElement)
        ]);

        if (shouldVerifyZoom && !zoomSettled.success) {
            const warning = 'Selfie camera: ' + zoomSettled.reason + ' Displaying the default field of view.';
            console.warn('Selfie camera zoom verification failed:', zoomSettled.reason);
            zoomWarningMessage = warning;
        }
    } catch (error) {
        console.error('Selfie camera stream failed to become ready:', error);
        stopStream(stream);
        setSelfieStream(null);
        dom.selfieVideoElement.srcObject = null;
        showError('Selfie camera: Unable to load camera stream.');
        return false;
    }

    const videoWidth = dom.selfieVideoElement.videoWidth;
    const videoHeight = dom.selfieVideoElement.videoHeight;
    if (videoWidth && videoHeight) {
        updateCameraHalfAspect('selfie', videoWidth / videoHeight);
    } else {
        console.warn('Selfie camera metadata unavailable after initialization.');
    }

    if (typeof zoomResult.appliedZoom === 'number') {
        const selfieState = interactionState.selfie;
        if (selfieState) {
            selfieState.streamZoom.current = zoomResult.appliedZoom;
        }
    }

    if (zoomWarningMessage) {
        showWarning(zoomWarningMessage);
    } else {
        hideError();
    }
    prepareSlotForLiveView('selfie');
    dom.selfieVideoElement.classList.add('active');
    const selfieState = interactionState.selfie;
    if (selfieState) {
        selfieState.lastTap = null;
        selfieState.lastSubmittedSignature = null;
        clearMovementDebounce('selfie');
    }
    setIsSelfieActive(true);
    dom.selfiePlaceholder.classList.add('hidden');

    return true;
}

/**
 * Open back camera
 */
export async function openBackCamera() {
    if (getIsOpeningBackCamera()) {
        console.warn('Back camera start request ignored: initialization already in progress.');
        return;
    }

    setIsOpeningBackCamera(true);

    if (!checkCameraSupport()) {
        setIsOpeningBackCamera(false);
        return;
    }

    try {
        await stopAllCamerasAndWait();

        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                video: {
                    facingMode: 'environment',
                    width: { ideal: 1920 },
                    height: { ideal: 1080 },
                    advanced: [{ zoom: BACK_TARGET_ZOOM }]
                }
            });
            const activated = await activateBackStream(stream);
            if (!activated) {
                return;
            }
            
        } catch (error) {
            console.error('Error accessing back camera:', error);
            
            if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
                showError('Back camera access was denied.');
            } else if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') {
                showError('No back camera found.');
            } else {
                try {
                    const stream = await navigator.mediaDevices.getUserMedia({
                        video: { facingMode: 'environment' }
                    });
                    const activated = await activateBackStream(stream);
                    if (!activated) {
                        return;
                    }
                } catch (retryError) {
                    console.warn('Back camera fallback without zoom constraint failed, retrying with generic video request.', retryError);
                    try {
                        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
                        const activated = await activateBackStream(stream);
                        if (!activated) {
                            return;
                        }
                    } catch (finalRetryError) {
                        console.error('Final attempt to access back camera failed:', finalRetryError);
                        showError('Failed to access back camera.');
                    }
                }
            }
        }
    } finally {
        setIsOpeningBackCamera(false);
    }
}

/**
 * Open selfie camera
 */
export async function openSelfieCamera() {
    if (getIsOpeningSelfieCamera()) {
        console.warn('Selfie camera start request ignored: initialization already in progress.');
        return;
    }

    setIsOpeningSelfieCamera(true);

    if (!checkCameraSupport()) {
        setIsOpeningSelfieCamera(false);
        return;
    }

    try {
        await stopAllCamerasAndWait();

        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                video: {
                    facingMode: 'user',
                    width: { ideal: 1920 },
                    height: { ideal: 1080 }
                }
            });
            const activated = await activateSelfieStream(stream);
            if (!activated) {
                return;
            }
            
        } catch (error) {
            console.error('Error accessing selfie camera:', error);

            const errorMessageText = error?.message || '';
            const shouldRetryAfterRelease = error?.name === 'NotReadableError'
                || /could not start video source/i.test(errorMessageText);

            if (shouldRetryAfterRelease) {
                await stopAllCamerasAndWait();
                await new Promise(resolve => setTimeout(resolve, 150));

                try {
                    const retryStream = await navigator.mediaDevices.getUserMedia({
                        video: {
                            facingMode: 'user',
                            width: { ideal: 1920 },
                            height: { ideal: 1080 }
                        }
                    });
                    const activated = await activateSelfieStream(retryStream);
                    if (activated) {
                        return;
                    }
                } catch (retryError) {
                    console.error('Selfie camera retry after release failed:', retryError);
                }
            }
            
            try {
                const devices = await navigator.mediaDevices.enumerateDevices();
                const videoDevices = devices.filter(device => device.kind === 'videoinput');
                
                if (videoDevices.length > 1) {
                    const backStream = getBackStream();
                    const backTrack = backStream?.getVideoTracks()[0];
                    const backDeviceId = backTrack?.getSettings().deviceId;
                    
                    const frontDevice = videoDevices.find(device => 
                        device.deviceId && device.deviceId !== backDeviceId
                    );
                    
                    if (frontDevice && frontDevice.deviceId) {
                        const stream = await navigator.mediaDevices.getUserMedia({
                            video: { deviceId: { exact: frontDevice.deviceId } }
                        });
                        const activated = await activateSelfieStream(stream);
                        if (!activated) {
                            return;
                        }
                        return;
                    }
                }
                
                const stream = await navigator.mediaDevices.getUserMedia({ 
                    video: { facingMode: 'user' } 
                });
                const activated = await activateSelfieStream(stream);
                if (!activated) {
                    return;
                }
                
            } catch (retryError) {
                console.error('Retry failed:', retryError);
                try {
                    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
                    const activated = await activateSelfieStream(stream);
                    if (!activated) {
                        return;
                    }
                } catch (finalError) {
                    console.error('Final attempt failed:', finalError);
                    showError('Selfie camera: ' + (finalError.message || 'Unable to access front camera.'));
                }
            }
        }
    } finally {
        setIsOpeningSelfieCamera(false);
    }
}

/**
 * Capture photo from back camera
 */
export function captureBackPhoto() {
    const backStream = getBackStream();
    const isBackActive = getIsBackActive();
    
    if (!backStream || !isBackActive) return;

    const videoWidth = dom.backVideoElement.videoWidth;
    const videoHeight = dom.backVideoElement.videoHeight;

    if (!videoWidth || !videoHeight) {
        console.warn('Back camera metadata unavailable; capture skipped.');
        return;
    }

    updateCameraHalfAspect('back', videoWidth / videoHeight);

    const canvas = document.createElement('canvas');
    canvas.width = videoWidth;
    canvas.height = videoHeight;

    const ctx = canvas.getContext('2d');

    ctx.drawImage(
        dom.backVideoElement,
        0, 0, videoWidth, videoHeight,
        0, 0, canvas.width, canvas.height
    );

    const photoDataUrl = canvas.toDataURL('image/png');
    displayPhotoForSide('you', photoDataUrl);
    
    setIsBackFrozen(true);
    
    // Stop camera
    stopAllCameras();
}

/**
 * Capture photo from selfie camera
 */
export function captureSelfiePhoto() {
    const selfieStream = getSelfieStream();
    const isSelfieActive = getIsSelfieActive();
    
    if (!selfieStream || !isSelfieActive) return;

    const videoWidth = dom.selfieVideoElement.videoWidth;
    const videoHeight = dom.selfieVideoElement.videoHeight;
    if (!videoWidth || !videoHeight) {
        console.warn('Selfie camera metadata unavailable; capture skipped.');
        return;
    }

    updateCameraHalfAspect('selfie', videoWidth / videoHeight);

    const canvas = document.createElement('canvas');
    canvas.width = videoWidth;
    canvas.height = videoHeight;

    const ctx = canvas.getContext('2d');

    ctx.drawImage(
        dom.selfieVideoElement,
        0, 0, videoWidth, videoHeight,
        0, 0, canvas.width, canvas.height
    );

    const photoDataUrl = canvas.toDataURL('image/png');
    displayPhotoForSide('me', photoDataUrl);
    
    setIsSelfieFrozen(true);
    
    // Stop camera
    stopAllCameras();
}

/**
 * Reset back camera
 */
export function resetBackCamera() {
    if (!getIsBackFrozen()) return;
    
    initializePhotoSlot('back');
    setIsBackFrozen(false);
    resetDescriptionState('you');
}

/**
 * Reset selfie camera
 */
export function resetSelfieCamera() {
    if (!getIsSelfieFrozen()) return;
    
    initializePhotoSlot('selfie');
    setIsSelfieFrozen(false);
    resetDescriptionState('me');
}

