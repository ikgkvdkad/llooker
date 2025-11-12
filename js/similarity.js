// Similarity calculation and visualization

import { descriptionState } from './state.js';
import * as dom from './dom.js';

/**
 * Calculate cosine similarity between two vectors
 */
function cosineSimilarity(vecA, vecB) {
    if (!vecA || !vecB || vecA.length !== vecB.length) {
        return null;
    }

    let dotProduct = 0;
    let magnitudeA = 0;
    let magnitudeB = 0;

    for (let i = 0; i < vecA.length; i++) {
        dotProduct += vecA[i] * vecB[i];
        magnitudeA += vecA[i] * vecA[i];
        magnitudeB += vecB[i] * vecB[i];
    }

    magnitudeA = Math.sqrt(magnitudeA);
    magnitudeB = Math.sqrt(magnitudeB);

    if (magnitudeA === 0 || magnitudeB === 0) {
        return 0;
    }

    return dotProduct / (magnitudeA * magnitudeB);
}

/**
 * Update similarity bar based on current embeddings
 */
export function updateSimilarityBar() {
    const youEmbedding = descriptionState.you.embedding;
    const meEmbedding = descriptionState.me.embedding;

    if (!youEmbedding || !meEmbedding) {
        // Hide bar or show default state
        if (dom.similarityBarFill) {
            dom.similarityBarFill.style.height = '0%';
        }
        if (dom.similarityPercentage) {
            dom.similarityPercentage.textContent = '-';
        }
        return;
    }

    // Calculate similarity
    const similarity = cosineSimilarity(youEmbedding, meEmbedding);

    if (similarity === null) {
        console.warn('Failed to calculate similarity');
        return;
    }

    // Convert to percentage (cosine similarity is between -1 and 1, but embeddings are usually 0-1)
    // For portrait descriptions, we expect mostly positive similarities
    const percentage = Math.max(0, Math.min(100, similarity * 100));

    // Update bar height
    if (dom.similarityBarFill) {
        dom.similarityBarFill.style.height = `${percentage}%`;
    }

    // Update percentage text
    if (dom.similarityPercentage) {
        dom.similarityPercentage.textContent = `${Math.round(percentage)}%`;
    }

    console.log(`Similarity updated: ${percentage.toFixed(1)}%`);
}

/**
 * Store embedding for a side and update similarity
 */
export function storeEmbedding(side, embedding) {
    if (!embedding || !Array.isArray(embedding)) {
        console.warn(`Invalid embedding for ${side}`);
        return;
    }

    const state = descriptionState[side];
    if (!state) {
        console.warn(`Invalid side: ${side}`);
        return;
    }

    state.embedding = embedding;
    console.log(`Stored embedding for ${side} (${embedding.length} dimensions)`);

    // Update similarity bar
    updateSimilarityBar();
}

/**
 * Clear embedding for a side
 */
export function clearEmbedding(side) {
    const state = descriptionState[side];
    if (!state) return;

    state.embedding = null;
    updateSimilarityBar();
}

/**
 * Clear all embeddings
 */
export function clearAllEmbeddings() {
    descriptionState.you.embedding = null;
    descriptionState.me.embedding = null;
    updateSimilarityBar();
}

