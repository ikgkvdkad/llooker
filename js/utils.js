// Utility functions

import { DEFAULT_SELECTION_RECT, MIN_SELECTION_EDGE_PX } from './config.js';
import { photoSlots, selectionElements } from './state.js';

// Math utilities
export function clamp(value, min, max) {
    if (value < min) return min;
    if (value > max) return max;
    return value;
}

export function calculateDistance(pointerA, pointerB) {
    const dx = pointerA.clientX - pointerB.clientX;
    const dy = pointerA.clientY - pointerB.clientY;
    return Math.sqrt(dx * dx + dy * dy);
}

// Selection rect utilities
export function cloneSelectionRect(rect = DEFAULT_SELECTION_RECT) {
    return {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height
    };
}

export function getSelectionElements(slotKey) {
    return selectionElements[slotKey] || null;
}

export function getSelectionMinSize(containerRect) {
    if (!containerRect || !containerRect.width || !containerRect.height) {
        return { width: 0.3, height: 0.3 };
    }
    return {
        width: MIN_SELECTION_EDGE_PX / containerRect.width,
        height: MIN_SELECTION_EDGE_PX / containerRect.height
    };
}

export function clampRectToBounds(rect) {
    const x = clamp(rect.x, 0, 1);
    const y = clamp(rect.y, 0, 1);
    const width = clamp(rect.width, 0, 1 - x);
    const height = clamp(rect.height, 0, 1 - y);
    const overflowX = x + width - 1;
    const finalX = overflowX > 0 ? x - overflowX : x;
    const finalWidth = overflowX > 0 ? width - overflowX : width;
    
    const overflowY = y + height - 1;
    const finalY = overflowY > 0 ? y - overflowY : y;
    const finalHeight = overflowY > 0 ? height - overflowY : height;
    
    return {
        x: finalX,
        y: finalY,
        width: finalWidth,
        height: finalHeight
    };
}

// Photo slot utilities
export function getPhotoSlotByAnalysisSide(side) {
    if (side === 'you') {
        return photoSlots.back;
    }
    if (side === 'me') {
        return photoSlots.selfie;
    }
    return null;
}

// File reading utility
export function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
        if (!file) {
            reject(new Error('No file provided.'));
            return;
        }

        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error || new Error('Unable to read file.'));
        reader.readAsDataURL(file);
    });
}

// Image loading utility
export function loadImageElement(dataUrl) {
    return new Promise((resolve, reject) => {
        const image = new Image();
        image.decoding = 'async';
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error('Unable to load image.'));
        image.src = dataUrl;
    });
}

