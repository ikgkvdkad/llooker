// AI vision-based similarity calculation and visualization

import { analysisState } from './state.js';
import * as dom from './dom.js';
import { setPersonIdentifierBadge } from './ui.js';

/**
 * Store photo data for a side and trigger similarity check
 */
export function storePhotoData(side, imageDataUrl, analysis = null, capturedAt = null, discriminators = null) {
    if (!imageDataUrl || typeof imageDataUrl !== 'string') {
        console.warn(`Invalid imageDataUrl for ${side}`);
        return;
    }

    const state = analysisState[side];
    if (!state) {
        console.warn(`Invalid side: ${side}`);
        return;
    }

    state.imageDataUrl = imageDataUrl;
    state.analysis = analysis;
    state.discriminators = discriminators;
    state.capturedAt = capturedAt;
    
    console.log(`Stored photo data for ${side}:`, {
        hasImage: !!imageDataUrl,
        gender: analysis?.subject?.gender,
        ageRange: analysis?.subject?.ageRange || analysis?.subject?.ageBucket,
        capturedAt: capturedAt
    });

    // Trigger similarity check if both photos ready
    updateSimilarityBar();
}

/**
 * Update similarity bar using AI vision comparison
 */
export async function updateSimilarityBar() {
    const youData = analysisState.you;
    const meData = analysisState.me;

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
        gender: youData.analysis?.subject?.gender, 
        age: youData.analysis?.subject?.ageRange || youData.analysis?.subject?.ageBucket,
        capturedAt: youData.capturedAt 
    });
    console.log('Me:', { 
        gender: meData.analysis?.subject?.gender, 
        age: meData.analysis?.subject?.ageRange || meData.analysis?.subject?.ageBucket,
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
                    analysis: youData.analysis,
                    discriminators: youData.discriminators,
                    capturedAt: youData.capturedAt
                },
                photo2: {
                    imageDataUrl: meData.imageDataUrl,
                    analysis: meData.analysis,
                    discriminators: meData.discriminators,
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
        analysisState.lastSimilarityResult = {
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
        analysisState.lastSimilarityError = {
            message: error.message,
            timestamp: new Date().toISOString()
        };
    }
}

/**
 * Clear photo data for a side
 */
export function clearPhotoData(side) {
    const state = analysisState[side];
    if (!state) return;

    state.imageDataUrl = null;
    state.analysis = null;
    state.discriminators = null;
    state.capturedAt = null;
    state.personGroup = null;
    setPersonIdentifierBadge(side, null);
    
    // Reset similarity bar
    updateSimilarityBar();
}

/**
 * Clear all photo data
 */
export function clearAllPhotoData() {
    analysisState.you.imageDataUrl = null;
    analysisState.you.analysis = null;
    analysisState.you.discriminators = null;
    analysisState.you.capturedAt = null;
    analysisState.you.personGroup = null;
    setPersonIdentifierBadge('you', null);
    analysisState.me.imageDataUrl = null;
    analysisState.me.analysis = null;
    analysisState.me.discriminators = null;
    analysisState.me.capturedAt = null;
    analysisState.me.personGroup = null;
    setPersonIdentifierBadge('me', null);
    
    // Clear stored results
    analysisState.lastSimilarityResult = null;
    analysisState.lastSimilarityError = null;
    
    updateSimilarityBar();
}
