// AI vision-based similarity calculation and visualization

import { descriptionState } from './state.js';
import * as dom from './dom.js';

/**
 * Store photo data for a side and trigger similarity check
 */
export function storePhotoData(side, imageDataUrl, metadata = null, capturedAt = null) {
    if (!imageDataUrl || typeof imageDataUrl !== 'string') {
        console.warn(`Invalid imageDataUrl for ${side}`);
        return;
    }

    const state = descriptionState[side];
    if (!state) {
        console.warn(`Invalid side: ${side}`);
        return;
    }

    state.imageDataUrl = imageDataUrl;
    state.metadata = metadata;
    state.capturedAt = capturedAt;
    
    console.log(`Stored photo data for ${side}:`, {
        hasImage: !!imageDataUrl,
        gender: metadata?.gender,
        ageRange: metadata?.ageRange,
        capturedAt: capturedAt
    });

    // Trigger similarity check if both photos ready
    updateSimilarityBar();
}

/**
 * Update similarity bar using AI vision comparison
 */
export async function updateSimilarityBar() {
    const youData = descriptionState.you;
    const meData = descriptionState.me;

    // Check if both photos are ready
    if (!youData.imageDataUrl || !meData.imageDataUrl) {
        // Reset bar if either photo is missing
        if (dom.similarityBarFill) {
            dom.similarityBarFill.style.height = '0%';
        }
        if (dom.similarityPercentage) {
            dom.similarityPercentage.textContent = '-';
        }
        return;
    }

    // Show loading state
    if (dom.similarityPercentage) {
        dom.similarityPercentage.textContent = '...';
    }

    console.log('=== REQUESTING AI VISION MATCH ===');
    console.log('You:', { 
        gender: youData.metadata?.gender, 
        age: youData.metadata?.ageRange,
        capturedAt: youData.capturedAt 
    });
    console.log('Me:', { 
        gender: meData.metadata?.gender, 
        age: meData.metadata?.ageRange,
        capturedAt: meData.capturedAt 
    });

    try {
        // Call AI vision matching function
        const response = await fetch('/.netlify/functions/ai-vision-match', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                photo1: {
                    imageDataUrl: youData.imageDataUrl,
                    metadata: youData.metadata,
                    capturedAt: youData.capturedAt
                },
                photo2: {
                    imageDataUrl: meData.imageDataUrl,
                    metadata: meData.metadata,
                    capturedAt: meData.capturedAt
                }
            })
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.error || `HTTP ${response.status}`);
        }

        const result = await response.json();

        console.log('=== AI VISION MATCH RESULT ===');
        console.log('Similarity:', result.similarity + '%');
        console.log('Confidence:', result.confidence);
        console.log('Reasoning:', result.reasoning);
        console.log('Fatal mismatch:', result.fatal_mismatch || 'none');
        console.log('Time difference:', result.timeDiffMinutes ? `${result.timeDiffMinutes} min` : 'unknown');

        // Update similarity bar with AI result
        const percentage = Math.max(0, Math.min(100, result.similarity));

        if (dom.similarityBarFill) {
            dom.similarityBarFill.style.height = `${percentage}%`;
        }

        if (dom.similarityPercentage) {
            dom.similarityPercentage.textContent = `${percentage}%`;
        }

        // Store result in state for reference
        descriptionState.lastSimilarityResult = {
            similarity: percentage,
            confidence: result.confidence,
            reasoning: result.reasoning,
            fatal_mismatch: result.fatal_mismatch,
            timestamp: new Date().toISOString()
        };

    } catch (error) {
        console.error('AI vision matching failed:', error);
        
        // Show error state
        if (dom.similarityPercentage) {
            dom.similarityPercentage.textContent = 'ERR';
        }
        
        // Store error for debugging
        descriptionState.lastSimilarityError = {
            message: error.message,
            timestamp: new Date().toISOString()
        };
    }
}

/**
 * Clear photo data for a side
 */
export function clearPhotoData(side) {
    const state = descriptionState[side];
    if (!state) return;

    state.imageDataUrl = null;
    state.metadata = null;
    state.capturedAt = null;
    
    // Reset similarity bar
    updateSimilarityBar();
}

/**
 * Clear all photo data
 */
export function clearAllPhotoData() {
    descriptionState.you.imageDataUrl = null;
    descriptionState.you.metadata = null;
    descriptionState.you.capturedAt = null;
    descriptionState.me.imageDataUrl = null;
    descriptionState.me.metadata = null;
    descriptionState.me.capturedAt = null;
    
    // Clear stored results
    descriptionState.lastSimilarityResult = null;
    descriptionState.lastSimilarityError = null;
    
    updateSimilarityBar();
}
