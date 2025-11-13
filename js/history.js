// History browsing and navigation

import { ANALYSIS_API_URL } from './config.js';
import { historyState, photoSlots, interactionState } from './state.js';
import { setAnalysisState, renderAnalysisSummary } from './analysis-api.js';
import { hideSelectionOverlay } from './selection.js';
import * as dom from './dom.js';

const HISTORY_API_URL = ANALYSIS_API_URL?.replace('/describe', '/get-analyses') || '/.netlify/functions/get-analyses';

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
 * Fetch analyses from database
 */
export async function fetchAnalyses(side, options = {}) {
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
            state.analyses = data.analyses || [];
        } else {
            state.analyses.push(...(data.analyses || []));
        }
        
        state.total = data.pagination?.total || 0;
        state.hasLoaded = true;
        
        updateNavigationButtons(side);
        
        return data;
    } catch (error) {
        console.error(`Failed to fetch ${side} analyses:`, error);
        throw error;
    } finally {
        state.isLoading = false;
    }
}

/**
 * Navigate to previous analysis (older)
 */
export async function navigatePrevious(side) {
    const state = historyState[side];
    
    // Stop camera if active and update button state
    const slotKey = side === 'you' ? 'back' : 'selfie';
    import('./camera.js').then(camera => {
        if (camera.isCameraActive(slotKey)) {
            camera.stopCamera(slotKey);
        }
        // Update camera button appearance
        const button = side === 'you' ? dom.youCameraButton : dom.meCameraButton;
        if (button) {
            camera.updateCameraButtonState(side, button);
        }
    }).catch(() => {
        // Camera module not available
    });
    
    // Load history if not loaded yet
    if (!state.hasLoaded) {
        try {
            await fetchAnalyses(side);
        } catch (error) {
            console.error('Failed to load history:', error);
            return;
        }
    }
    
    if (state.analyses.length === 0) {
        return;
    }
    
    // If currently at live view (-1), go to first history item (0)
    // Otherwise increment index
    if (state.currentIndex === -1) {
        state.currentIndex = 0;
    } else if (state.currentIndex < state.analyses.length - 1) {
        state.currentIndex++;
    } else {
        // Already at oldest, do nothing
        return;
    }
    
    displayHistoryItem(side);
    updateNavigationButtons(side);
}

/**
 * Navigate to next analysis (newer)
 */
export function navigateNext(side) {
    const state = historyState[side];
    
    if (state.currentIndex === -1) {
        // Already at live view
        return;
    }
    
    // Stop camera if active and update button state
    const slotKey = side === 'you' ? 'back' : 'selfie';
    import('./camera.js').then(camera => {
        if (camera.isCameraActive(slotKey)) {
            camera.stopCamera(slotKey);
        }
        // Update camera button appearance
        const button = side === 'you' ? dom.youCameraButton : dom.meCameraButton;
        if (button) {
            camera.updateCameraButtonState(side, button);
        }
    }).catch(() => {
        // Camera module not available
    });
    
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
    const item = state.analyses[state.currentIndex];
    
    if (!item) {
        console.warn(`No history item at index ${state.currentIndex} for ${side}`);
        return;
    }
    
    const slotKey = side === 'you' ? 'back' : 'selfie';
    const slot = photoSlots[slotKey];
    
    // Display the photo - this is the cropped viewport that was analyzed
    // NOTE: imageDataUrl is the CROPPED selection area, not the original full photo
    if (item.imageDataUrl && slot.imageEl) {
        slot.imageEl.src = item.imageDataUrl;
        slot.imageEl.classList.add('active');
        slot.lastPhotoDataUrl = item.imageDataUrl;
        
        // Hide placeholder
        if (slot.placeholderEl) {
            slot.placeholderEl.style.display = 'none';
        }
    }
    
    // HIDE the selection overlay - we're showing the already-cropped image
    // The displayed image IS the selection area, so showing a selection box would be redundant
    hideSelectionOverlay(slotKey);
    
    // Reset transform/zoom to show full image
    const interaction = interactionState[slotKey];
    if (interaction) {
        interaction.transform.scale = 1;
        interaction.transform.translateX = 0;
        interaction.transform.translateY = 0;
        
        if (slot.imageEl) {
            // Don't apply any transform - let CSS handle centering with object-fit: contain
            slot.imageEl.style.transform = 'translate(0px, 0px) scale(1)';
        }
    }
    
    // Build analysis text with metadata
    const timestamp = formatTimestamp(item.capturedAt || item.createdAt);
    const location = formatLocation(item.location);
    
    let statusText = `${side === 'you' ? 'You' : 'Me'} - ${timestamp}`;
    
    if (location && location !== 'Location unavailable') {
        statusText += `\nLocation: ${location}`;
    }
    
    // Show history indicator
    const position = state.currentIndex + 1;
    const total = state.analyses.length;
    statusText += `\n[History: ${position} of ${total}]`;
    
    const analysisSummary = renderAnalysisSummary(item.analysis || {}, item.discriminators || {});
    setAnalysisState(side, 'success', statusText, analysisSummary);
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
    
    // Don't clear the photo - just reset to current state
    // The user will need to capture a new photo or open camera
    
    // Reset analysis panel to waiting state
    const label = side === 'you' ? 'You' : 'Me';
    setAnalysisState(
        side,
        null,
        `Waiting for a ${label} capture. Capture or upload a photo, then pan and zoom to center the subject.`
    );
}

/**
 * Check if currently viewing history
 */
export function isViewingHistory(side) {
    const state = historyState[side];
    return state.currentIndex > -1;
}

/**
 * Exit history mode and reset to live view
 */
export function exitHistoryMode(side) {
    const state = historyState[side];
    if (state.currentIndex === -1) return; // Already in live view
    
    returnToLiveView(side);
    updateNavigationButtons(side);
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
                      (state.currentIndex === -1 && state.analyses.length > 0) ||
                      (state.currentIndex >= 0 && state.currentIndex < state.analyses.length - 1);
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
 * Add new analysis to history (called after successful API response)
 */
export function addToHistory(side, analysisRecord) {
    const state = historyState[side];
    
    // Add to front of array (newest first)
    state.analyses.unshift(analysisRecord);
    state.total++;
    
    // If we're at live view, stay at live view
    // Otherwise, increment currentIndex since we added an item at the front
    if (state.currentIndex > -1) {
        state.currentIndex++;
    }
    
    updateNavigationButtons(side);
}

