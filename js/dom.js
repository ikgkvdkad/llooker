// DOM element references

// Back camera elements
export const backVideoElement = document.getElementById('backVideoElement');
export const backCapturedPhoto = document.getElementById('backCapturedPhoto');
export const backCameraHalf = document.getElementById('backCameraHalf');
export const backPlaceholder = document.getElementById('backPlaceholder');
export const youIdentifierBadge = document.getElementById('youIdentifierBadge');

// Selfie camera elements
export const selfieVideoElement = document.getElementById('selfieVideoElement');
export const selfieCapturedPhoto = document.getElementById('selfieCapturedPhoto');
export const selfieCameraHalf = document.getElementById('selfieCameraHalf');
export const selfiePlaceholder = document.getElementById('selfiePlaceholder');
export const meIdentifierBadge = document.getElementById('meIdentifierBadge');

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
export const toastStack = document.getElementById('toastStack');
export const versionDisplay = document.getElementById('versionDisplay');

// Analysis panels
export const youAnalysisPanel = document.getElementById('youAnalysisPanel');
export const youAnalysisStatus = document.getElementById('youAnalysisStatus');
export const youAnalysisContent = document.getElementById('youAnalysisContent');

export const meAnalysisPanel = document.getElementById('meAnalysisPanel');
export const meAnalysisStatus = document.getElementById('meAnalysisStatus');
export const meAnalysisContent = document.getElementById('meAnalysisContent');

// Control buttons
export const youReanalyzeButton = document.getElementById('youReanalyzeButton');
export const meReanalyzeButton = document.getElementById('meReanalyzeButton');
export const youCameraButton = document.getElementById('youCameraButton');
export const meCameraButton = document.getElementById('meCameraButton');
export const youUploadButton = document.getElementById('youUploadButton');
export const meUploadButton = document.getElementById('meUploadButton');
export const youUploadInput = document.getElementById('youUploadInput');
export const meUploadInput = document.getElementById('meUploadInput');

// History navigation buttons
export const youPrevButton = document.getElementById('youPrevButton');
export const youNextButton = document.getElementById('youNextButton');
export const mePrevButton = document.getElementById('mePrevButton');
export const meNextButton = document.getElementById('meNextButton');

// Similarity bar elements
export const similarityBarContainer = document.getElementById('similarityBarContainer');
export const similarityBarFill = document.getElementById('similarityBarFill');
export const similarityPercentage = document.getElementById('similarityPercentage');

