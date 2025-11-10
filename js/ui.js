// UI helpers and utilities

import { APP_VERSION } from './config.js';
import * as dom from './dom.js';

/**
 * Error message display
 */
export function showError(message) {
    if (typeof message === 'string') {
        dom.errorMessage.textContent = message;
    }
    dom.errorMessage.classList.remove('warning');
    dom.errorMessage.classList.add('active');
}

export function showWarning(message) {
    if (typeof message === 'string') {
        dom.errorMessage.textContent = message;
    }
    dom.errorMessage.classList.add('active', 'warning');
    console.warn(message);
}

export function hideError() {
    dom.errorMessage.classList.remove('active');
    dom.errorMessage.classList.remove('warning');
}

/**
 * Version display
 */
export function renderAppVersion() {
    if (!dom.versionDisplay) {
        return;
    }
    const label = `v${APP_VERSION}`;
    dom.versionDisplay.textContent = label;
    dom.versionDisplay.setAttribute('aria-label', `Application version ${APP_VERSION}`);
}

