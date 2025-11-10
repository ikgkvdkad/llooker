// DOM element references

// Back camera elements
export const backVideoElement = document.getElementById('backVideoElement');
export const backCapturedPhoto = document.getElementById('backCapturedPhoto');
export const backCameraHalf = document.getElementById('backCameraHalf');
export const backPlaceholder = document.getElementById('backPlaceholder');

// Selfie camera elements
export const selfieVideoElement = document.getElementById('selfieVideoElement');
export const selfieCapturedPhoto = document.getElementById('selfieCapturedPhoto');
export const selfieCameraHalf = document.getElementById('selfieCameraHalf');
export const selfiePlaceholder = document.getElementById('selfiePlaceholder');

// Selection overlays
export const backSelectionOverlay = document.getElementById('backSelectionOverlay');
export const backSelectionBox = document.getElementById('backSelectionBox');
export const selfieSelectionOverlay = document.getElementById('selfieSelectionOverlay');
export const selfieSelectionBox = document.getElementById('selfieSelectionBox');

export const backSelectionHandles = {
    'top-left': backSelectionBox?.querySelector('.corner-handle.top-left') || null,
    'top-right': backSelectionBox?.querySelector('.corner-handle.top-right') || null,
    'bottom-left': backSelectionBox?.querySelector('.corner-handle.bottom-left') || null,
    'bottom-right': backSelectionBox?.querySelector('.corner-handle.bottom-right') || null
};

export const selfieSelectionHandles = {
    'top-left': selfieSelectionBox?.querySelector('.corner-handle.top-left') || null,
    'top-right': selfieSelectionBox?.querySelector('.corner-handle.top-right') || null,
    'bottom-left': selfieSelectionBox?.querySelector('.corner-handle.bottom-left') || null,
    'bottom-right': selfieSelectionBox?.querySelector('.corner-handle.bottom-right') || null
};

// UI elements
export const errorMessage = document.getElementById('errorMessage');
export const versionDisplay = document.getElementById('versionDisplay');

// Description panels
export const youDescriptionPanel = document.getElementById('youDescriptionPanel');
export const youDescriptionStatus = document.getElementById('youDescriptionStatus');
export const youDescriptionContent = document.getElementById('youDescriptionContent');

export const meDescriptionPanel = document.getElementById('meDescriptionPanel');
export const meDescriptionStatus = document.getElementById('meDescriptionStatus');
export const meDescriptionContent = document.getElementById('meDescriptionContent');

// Control buttons
export const youResubmitButton = document.getElementById('youResubmitButton');
export const meResubmitButton = document.getElementById('meResubmitButton');
export const youCameraButton = document.getElementById('youCameraButton');
export const meCameraButton = document.getElementById('meCameraButton');
export const youUploadButton = document.getElementById('youUploadButton');
export const meUploadButton = document.getElementById('meUploadButton');
export const youUploadInput = document.getElementById('youUploadInput');
export const meUploadInput = document.getElementById('meUploadInput');

