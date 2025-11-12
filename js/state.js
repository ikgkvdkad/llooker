// Application state management

import { DEFAULT_BACK_ASPECT, DEFAULT_SELFIE_ASPECT, DEFAULT_SELECTION_RECT } from './config.js';
import * as dom from './dom.js';

// Photo slots state
export const photoSlots = {
    back: {
        imageEl: dom.backCapturedPhoto,
        placeholderEl: dom.backPlaceholder,
        lastPhotoDataUrl: null
    },
    selfie: {
        imageEl: dom.selfieCapturedPhoto,
        placeholderEl: dom.selfiePlaceholder,
        lastPhotoDataUrl: null
    }
};

// Camera layout state
export const cameraLayoutState = {
    back: { aspectRatio: DEFAULT_BACK_ASPECT, element: dom.backCameraHalf },
    selfie: { aspectRatio: DEFAULT_SELFIE_ASPECT, element: dom.selfieCameraHalf }
};

// Selection elements lookup
export const selectionElements = {
    back: {
        overlay: dom.backSelectionOverlay,
        box: dom.backSelectionBox,
        handles: dom.backSelectionHandles
    },
    selfie: {
        overlay: dom.selfieSelectionOverlay,
        box: dom.selfieSelectionBox,
        handles: dom.selfieSelectionHandles
    }
};

// Interaction state factory
export function createInteractionState() {
    return {
        pointerMap: new Map(),
        baseDistance: null,
        baseZoom: null,
        panStart: null,
        tapCandidate: null,
        lastTap: null,
        pendingZoom: null,
        zoomUpdateFrame: null,
        zoomUpdateInFlight: false,
        zoomSupported: false,
        streamZoom: {
            min: 1,
            max: 1,
            current: 1
        },
        transform: {
            scale: 1,
            translateX: 0,
            translateY: 0
        },
        transformBounds: {
            maxScale: 4
        },
        lastSubmittedSignature: null,
        movementDebounceId: null,
        lastInteractionAt: 0
    };
}

// Interaction state per slot
export const interactionState = {
    back: createInteractionState(),
    selfie: createInteractionState()
};

// Selection state factory
function cloneSelectionRect(rect = DEFAULT_SELECTION_RECT) {
    return {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height
    };
}

export function createSelectionState() {
    return {
        rect: cloneSelectionRect(),
        activePointerId: null,
        mode: null,
        startRect: null,
        startPoint: null,
        activeElement: null,
        lastInteractionAt: 0
    };
}

// Selection state per slot
export const selectionState = {
    back: createSelectionState(),
    selfie: createSelectionState()
};

// Description state
export const descriptionState = {
    you: {
        panel: dom.youDescriptionPanel,
        statusEl: dom.youDescriptionStatus,
        contentEl: dom.youDescriptionContent,
        imageDataUrl: null,
        metadata: null,
        capturedAt: null
    },
    me: {
        panel: dom.meDescriptionPanel,
        statusEl: dom.meDescriptionStatus,
        contentEl: dom.meDescriptionContent,
        imageDataUrl: null,
        metadata: null,
        capturedAt: null
    },
    lastSimilarityResult: null,
    lastSimilarityError: null
};

// Description queue
export const descriptionQueue = [];
export let isDescriptionInFlight = false;

export function setDescriptionInFlight(value) {
    isDescriptionInFlight = value;
}

export function getDescriptionInFlight() {
    return isDescriptionInFlight;
}

// History state
export const historyState = {
    you: {
        descriptions: [],
        currentIndex: -1, // -1 means showing live/latest
        isLoading: false,
        hasLoaded: false,
        total: 0
    },
    me: {
        descriptions: [],
        currentIndex: -1,
        isLoading: false,
        hasLoaded: false,
        total: 0
    }
};

// Camera state
export let backStream = null;
export let isBackFrozen = false;
export let isBackActive = false;
export let backInitializationTimeoutId = null;

export let selfieStream = null;
export let isSelfieFrozen = false;
export let isSelfieActive = false;

export let isOpeningBackCamera = false;
export let isOpeningSelfieCamera = false;

// Camera state setters
export function setBackStream(stream) { backStream = stream; }
export function setIsBackFrozen(value) { isBackFrozen = value; }
export function setIsBackActive(value) { isBackActive = value; }
export function setBackInitializationTimeoutId(id) { backInitializationTimeoutId = id; }

export function setSelfieStream(stream) { selfieStream = stream; }
export function setIsSelfieFrozen(value) { isSelfieFrozen = value; }
export function setIsSelfieActive(value) { isSelfieActive = value; }

export function setIsOpeningBackCamera(value) { isOpeningBackCamera = value; }
export function setIsOpeningSelfieCamera(value) { isOpeningSelfieCamera = value; }

// Camera state getters
export function getBackStream() { return backStream; }
export function getIsBackFrozen() { return isBackFrozen; }
export function getIsBackActive() { return isBackActive; }
export function getBackInitializationTimeoutId() { return backInitializationTimeoutId; }

export function getSelfieStream() { return selfieStream; }
export function getIsSelfieFrozen() { return isSelfieFrozen; }
export function getIsSelfieActive() { return isSelfieActive; }

export function getIsOpeningBackCamera() { return isOpeningBackCamera; }
export function getIsOpeningSelfieCamera() { return isOpeningSelfieCamera; }

