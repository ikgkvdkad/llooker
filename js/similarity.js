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
 * Apply non-linear transformation to spread out similarity scores
 * This makes differences more apparent, especially at lower similarities
 */
function transformSimilarity(rawSimilarity) {
    // Cosine similarity is typically 0.5-1.0 for text embeddings
    // We want to spread this range out more dramatically
    
    // Normalize to 0-1 range (assuming min similarity of 0.4)
    const normalized = Math.max(0, (rawSimilarity - 0.4) / 0.6);
    
    // Apply power function to exaggerate differences
    // Power of 1.8 makes small differences more visible
    const transformed = Math.pow(normalized, 1.8);
    
    return transformed;
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

    // Calculate raw cosine similarity
    const rawSimilarity = cosineSimilarity(youEmbedding, meEmbedding);

    if (rawSimilarity === null) {
        console.warn('Failed to calculate similarity');
        return;
    }

    // Apply transformation to spread out the range
    const transformedSimilarity = transformSimilarity(rawSimilarity);
    const percentage = Math.max(0, Math.min(100, transformedSimilarity * 100));

    // Update bar height
    if (dom.similarityBarFill) {
        dom.similarityBarFill.style.height = `${percentage}%`;
    }

    // Update percentage text
    if (dom.similarityPercentage) {
        dom.similarityPercentage.textContent = `${Math.round(percentage)}%`;
    }

    console.log(`Similarity: raw=${(rawSimilarity * 100).toFixed(1)}%, adjusted=${percentage.toFixed(1)}%`);
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

