// UI helpers and utilities

import { APP_VERSION } from './config.js';
import * as dom from './dom.js';
import { appendDiagnosticMessage } from './analysis-api.js';

const TOAST_DEFAULT_DURATION = 7000;
const TOAST_TYPE_DURATION = {
    error: 8000,
    warning: 6000
};

const toastTimers = new WeakMap();
const DEFAULT_DIAGNOSTIC_SIDES = ['you', 'me'];
const DIAGNOSTIC_SIDE_ALIASES = {
    you: 'you',
    me: 'me',
    back: 'you',
    selfie: 'me'
};

function getToastStack() {
    if (!dom.toastStack) {
        console.warn('Toast stack element missing. Falling back to console output only.');
    }
    return dom.toastStack;
}

function dismissToast(toast) {
    if (!toast) {
        return;
    }
    const timer = toastTimers.get(toast);
    if (timer) {
        window.clearTimeout(timer);
        toastTimers.delete(toast);
    }
    toast.classList.add('toast-leave');
    const handleAnimationEnd = () => {
        toast.removeEventListener('animationend', handleAnimationEnd);
        toast.remove();
    };
    toast.addEventListener('animationend', handleAnimationEnd);
}

function createToast(type, message) {
    const stack = getToastStack();
    if (!stack) {
        const logFn = type === 'error' ? console.error : console.warn;
        logFn(message);
        return null;
    }

    const toast = document.createElement('div');
    toast.className = `toast toast-${type} toast-enter`;
    toast.dataset.toastType = type;
    toast.setAttribute('role', type === 'error' ? 'alert' : 'status');

    const content = document.createElement('div');
    content.className = 'toast-content';

    const label = document.createElement('span');
    label.className = 'toast-message';
    label.textContent = message || '';

    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'toast-close';
    closeButton.setAttribute('aria-label', 'Dismiss notification');
    closeButton.textContent = 'X';
    closeButton.addEventListener('click', () => dismissToast(toast));

    content.appendChild(label);
    toast.appendChild(content);
    toast.appendChild(closeButton);
    stack.appendChild(toast);

    // Force reflow to trigger animation
    void toast.offsetHeight; // eslint-disable-line no-unused-expressions
    toast.classList.remove('toast-enter');

    const duration = TOAST_TYPE_DURATION[type] ?? TOAST_DEFAULT_DURATION;
    const timer = window.setTimeout(() => dismissToast(toast), duration);
    toastTimers.set(toast, timer);

    return toast;
}

/**
 * Error message display
 */
function resolveDiagnosticSides(options) {
    if (!options) {
        return DEFAULT_DIAGNOSTIC_SIDES;
    }

    const candidates = Array.isArray(options.sides ?? options.side)
        ? options.sides ?? options.side
        : (options.side !== undefined ? [options.side] : null);

    if (!candidates || !candidates.length) {
        return DEFAULT_DIAGNOSTIC_SIDES;
    }

    const resolved = [];
    for (const candidate of candidates) {
        if (typeof candidate !== 'string') {
            continue;
        }
        const normalized = candidate.trim().toLowerCase();
        if (!normalized.length) {
            continue;
        }
        if (normalized === 'both' || normalized === 'all') {
            return DEFAULT_DIAGNOSTIC_SIDES;
        }
        const mapped = DIAGNOSTIC_SIDE_ALIASES[normalized];
        if (mapped && !resolved.includes(mapped)) {
            resolved.push(mapped);
        }
    }

    return resolved.length ? resolved : DEFAULT_DIAGNOSTIC_SIDES;
}

function appendDiagnosticsForSides(type, message, options = {}) {
    if (options?.diagnostics === false) {
        return;
    }
    const sides = resolveDiagnosticSides(options);
    const detail = options?.detail;
    for (const side of sides) {
        appendDiagnosticMessage(side, message, { level: type, detail });
    }
}

export function showError(message, options = {}) {
    if (typeof message !== 'string') {
        return;
    }
    const normalized = message.trim();
    if (!normalized.length) {
        return;
    }
    console.error(normalized);
    createToast('error', normalized);
    appendDiagnosticsForSides('error', normalized, options);
}

export function showWarning(message, options = {}) {
    if (typeof message !== 'string') {
        return;
    }
    const normalized = message.trim();
    if (!normalized.length) {
        return;
    }
    console.warn(normalized);
    createToast('warning', normalized);
    appendDiagnosticsForSides('warning', normalized, options);
}

export function hideError() {
    const stack = getToastStack();
    if (!stack) {
        return;
    }
    const toasts = Array.from(stack.querySelectorAll('.toast'));
    toasts.forEach(toast => dismissToast(toast));
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

