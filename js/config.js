// Application configuration and constants

export const APP_VERSION = 9.0;

export const DEFAULT_BACK_ASPECT = 16 / 9;
export const DEFAULT_SELFIE_ASPECT = 16 / 9;

export const DEFAULT_IMAGES = {
    back: 'youphoto.jpg',
    selfie: 'mephoto.jpg'
};

export const MIN_SELECTION_EDGE_PX = 70;

export const DEFAULT_SELECTION_RECT = Object.freeze({
    x: 0.05,
    y: 0.05,
    width: 0.9,
    height: 0.9
});

export const BACK_TARGET_ZOOM = 2;
export const SELFIE_ZOOM_MODE = 'min';

export const DESCRIPTION_API_TIMEOUT_MS = 25000;
export const DESCRIPTION_MOVEMENT_DEBOUNCE_MS = 2000;

export const WAITING_FOR_DESCRIPTION_MESSAGE = 'Analyzing the framed subject... adjust the photo and hold steady to refresh.';

export const TAP_MAX_MOVEMENT_PX = 12;
export const TAP_MAX_DURATION_MS = 350;

export const CAMERA_RELEASE_TIMEOUT_MS = 500;

// Configure the API endpoint for Netlify Function
export const DESCRIPTION_API_URL = '/.netlify/functions/describe';

