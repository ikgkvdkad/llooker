// History browsing and navigation

import { DESCRIPTION_API_URL } from './config.js';
import { historyState, photoSlots, interactionState } from './state.js';
import { setDescriptionState } from './description-api.js';
import * as dom from './dom.js';

const HISTORY_API_URL = DESCRIPTION_API_URL?.replace('/describe', '/get-descriptions') || '/.netlify/functions/get-descriptions';

/**
 * Format timestamp for display
 */
function formatTimestamp(timestamp) {
    if (!timestamp) return 'Unknown time';
    
    try {
        const date = new Date(timestamp);
        if (isNaN(date.getTime())) return 'Invalid date';
        
        const now = new Date();
        const diffMs = now - date;
        const diffMins = Math.floor(diffMs / 60000);
        const diffHours = Math.floor(diffMs / 3600000);
        const diffDays = Math.floor(diffMs / 86400000);
        
        // Less than 1 hour: show "X minutes ago"
        if (diffMins < 60) {
            return diffMins <= 1 ? 'Just now' : `${diffMins} min ago`;
        }
        
        // Less than 24 hours: show "X hours ago"
        if (diffHours < 24) {
            return diffHours === 1 ? '1 hour ago' : `${diffHours} hours ago`;
        }
        
        // Less than 7 days: show "X days ago"
        if (diffDays < 7) {
            return diffDays === 1 ? 'Yesterday' : `${diffDays} days ago`;
        }
        
        // Otherwise show full date
        const options = { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' };
        return date.toLocaleString('en-US', options);
    } catch (error) {
        console.error('Error formatting timestamp:', error);
        return 'Unknown time';
    }
}

/**
 * Format location for display
 */
function formatLocation(location) {
    if (!location) return null;
    
    if (location.status !== 'ok' || !location.coordinates) {
        return location.error || 'Location unavailable';
    }
    
    const { latitude, longitude } = location.coordinates;
    const accuracy = location.accuracy;
    
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        return 'Invalid coordinates';
    }
    
    const latStr = latitude.toFixed(6);
    const lonStr = longitude.toFixed(6);
    const accStr = accuracy && Number.isFinite(accuracy) ? ` (±${Math.round(accuracy)}m)` : '';
    
    return `${latStr}, ${lonStr}${accStr}`;
}

/**
 * Fetch descriptions from database
 */
export async function fetchDescriptions(side, options = {}) {
    const state = historyState[side];
    const limit = options.limit || 50;
    const offset = options.offset || 0;
    
    state.isLoading = true;
    
    try {
        const url = `${HISTORY_API_URL}?role=${side}&limit=${limit}&offset=${offset}&status=ok`;
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            }
        });
        
        if (!response.ok) {
            const errorText = await response.text().catch(() => '');
            throw new Error(errorText || `HTTP ${response.status}`);
        }
        
        const data = await response.json();
        
        if (offset === 0) {
            state.descriptions = data.descriptions || [];
        } else {
            state.descriptions.push(...(data.descriptions || []));
        }
        
        state.total = data.pagination?.total || 0;
        state.hasLoaded = true;
        
        updateNavigationButtons(side);
        
        return data;
    } catch (error) {
        console.error(`Failed to fetch ${side} descriptions:`, error);
        throw error;
    } finally {
        state.isLoading = false;
    }
}

/**
 * Navigate to previous description (older)
 */
export async function navigatePrevious(side) {
    const state = historyState[side];
    
    // Load history if not loaded yet
    if (!state.hasLoaded) {
        try {
            await fetchDescriptions(side);
        } catch (error) {
            console.error('Failed to load history:', error);
            return;
        }
    }
    
    if (state.descriptions.length === 0) {
        return;
    }
    
    // If currently at live view (-1), go to first history item (0)
    // Otherwise increment index
    if (state.currentIndex === -1) {
        state.currentIndex = 0;
    } else if (state.currentIndex < state.descriptions.length - 1) {
        state.currentIndex++;
    } else {
        // Already at oldest, do nothing
        return;
    }
    
    displayHistoryItem(side);
    updateNavigationButtons(side);
}

/**
 * Navigate to next description (newer)
 */
export function navigateNext(side) {
    const state = historyState[side];
    
    if (state.currentIndex === -1) {
        // Already at live view
        return;
    }
    
    state.currentIndex--;
    
    if (state.currentIndex === -1) {
        // Return to live view
        returnToLiveView(side);
    } else {
        displayHistoryItem(side);
    }
    
    updateNavigationButtons(side);
}

/**
 * Display a history item
 */
function displayHistoryItem(side) {
    const state = historyState[side];
    const item = state.descriptions[state.currentIndex];
    
    if (!item) {
        console.warn(`No history item at index ${state.currentIndex} for ${side}`);
        return;
    }
    
    const slotKey = side === 'you' ? 'back' : 'selfie';
    const slot = photoSlots[slotKey];
    
    // Display the photo
    if (item.imageDataUrl && slot.imageEl) {
        slot.imageEl.src = item.imageDataUrl;
        slot.imageEl.classList.add('active');
        slot.lastPhotoDataUrl = item.imageDataUrl;
        
        // Hide placeholder
        if (slot.placeholderEl) {
            slot.placeholderEl.style.display = 'none';
        }
    }
    
    // Reset transform/zoom
    const interaction = interactionState[slotKey];
    if (interaction) {
        interaction.transform.scale = 1;
        interaction.transform.translateX = 0;
        interaction.transform.translateY = 0;
        
        if (slot.imageEl) {
            slot.imageEl.style.transform = 'translate(-50%, -50%) scale(1)';
        }
    }
    
    // Build description text with metadata
    const timestamp = formatTimestamp(item.capturedAt || item.createdAt);
    const location = formatLocation(item.location);
    
    let descriptionText = item.description || '';
    let statusText = `${side === 'you' ? 'You' : 'Me'} - ${timestamp}`;
    
    if (location && location !== 'Location unavailable') {
        statusText += `\nLocation: ${location}`;
    }
    
    // Show history indicator
    const position = state.currentIndex + 1;
    const total = state.descriptions.length;
    statusText += `\n[History: ${position} of ${total}]`;
    
    setDescriptionState(side, 'success', statusText, descriptionText);
}

/**
 * Return to live view
 */
function returnToLiveView(side) {
    const state = historyState[side];
    state.currentIndex = -1;
    
    // Clear the photo display and return to placeholder or current live photo
    const slotKey = side === 'you' ? 'back' : 'selfie';
    const slot = photoSlots[slotKey];
    
    // Reset description to waiting state
    const label = side === 'you' ? 'You' : 'Me';
    setDescriptionState(
        side,
        null,
        `Waiting for a ${label} capture. Capture or upload a photo, then pan and zoom to center the subject.`
    );
}

/**
 * Update navigation button states
 */
function updateNavigationButtons(side) {
    const state = historyState[side];
    const prevButton = side === 'you' ? dom.youPrevButton : dom.mePrevButton;
    const nextButton = side === 'you' ? dom.youNextButton : dom.meNextButton;
    
    if (!prevButton || !nextButton) return;
    
    // Previous button (go to older)
    // Enable if: not loaded yet (allows triggering fetch), OR currently at live view with history, OR viewing history with more items
    const canGoPrev = !state.hasLoaded || 
                      (state.currentIndex === -1 && state.descriptions.length > 0) ||
                      (state.currentIndex >= 0 && state.currentIndex < state.descriptions.length - 1);
    prevButton.disabled = !canGoPrev;
    
    // Next button (go to newer)
    const canGoNext = state.currentIndex > -1;
    nextButton.disabled = !canGoNext;
}

/**
 * Initialize navigation buttons
 */
export function initHistoryNavigation() {
    // You (back camera) buttons
    if (dom.youPrevButton) {
        dom.youPrevButton.addEventListener('click', () => navigatePrevious('you'));
    }
    
    if (dom.youNextButton) {
        dom.youNextButton.addEventListener('click', () => navigateNext('you'));
    }
    
    // Me (selfie) buttons
    if (dom.mePrevButton) {
        dom.mePrevButton.addEventListener('click', () => navigatePrevious('me'));
    }
    
    if (dom.meNextButton) {
        dom.meNextButton.addEventListener('click', () => navigateNext('me'));
    }
    
    // Initial button state
    updateNavigationButtons('you');
    updateNavigationButtons('me');
}

/**
 * Add new description to history (called after successful API response)
 */
export function addToHistory(side, description) {
    const state = historyState[side];
    
    // Add to front of array (newest first)
    state.descriptions.unshift(description);
    state.total++;
    
    // If we're at live view, stay at live view
    // Otherwise, increment currentIndex since we added an item at the front
    if (state.currentIndex > -1) {
        state.currentIndex++;
    }
    
    updateNavigationButtons(side);
}

