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
 * Check metadata compatibility between two people
 * Returns 0.0 for fatal mismatches (different gender, incompatible age)
 * Returns 0.0-1.0 for partial compatibility
 */
function checkMetadataCompatibility(metadata1, metadata2) {
    if (!metadata1 || !metadata2) {
        // If no metadata, fall back to vector-only comparison
        return 1.0;
    }

    // FATAL: Gender mismatch
    if (metadata1.gender && metadata2.gender && metadata1.gender !== 'unknown' && metadata2.gender !== 'unknown') {
        if (metadata1.gender !== metadata2.gender) {
            console.log('Metadata filter: Gender mismatch - returning 0%');
            return 0.0;
        }
    }

    // Calculate age overlap
    let ageScore = 1.0;
    if (metadata1.ageRange && metadata2.ageRange) {
        const parseAgeRange = (range) => {
            const parts = range.split('-').map(p => parseInt(p.trim()));
            return { min: parts[0] || 0, max: parts[1] || parts[0] || 100 };
        };

        const age1 = parseAgeRange(metadata1.ageRange);
        const age2 = parseAgeRange(metadata2.ageRange);

        // Calculate overlap
        const overlapMin = Math.max(age1.min, age2.min);
        const overlapMax = Math.min(age1.max, age2.max);
        const overlap = Math.max(0, overlapMax - overlapMin);

        const range1 = age1.max - age1.min;
        const range2 = age2.max - age2.min;
        const avgRange = (range1 + range2) / 2;

        ageScore = avgRange > 0 ? Math.min(1.0, overlap / avgRange) : 1.0;

        // FATAL: No age overlap at all
        if (overlap <= 0) {
            console.log('Metadata filter: No age overlap - returning 0%');
            return 0.0;
        }
    }

    // Other categorical compatibility (softer)
    let buildScore = 1.0;
    if (metadata1.build && metadata2.build && metadata1.build !== 'unknown' && metadata2.build !== 'unknown') {
        const buildMap = { 'slim': 1, 'athletic': 2, 'average': 3, 'stocky': 4, 'heavy': 5 };
        const build1 = buildMap[metadata1.build] || 3;
        const build2 = buildMap[metadata2.build] || 3;
        const buildDiff = Math.abs(build1 - build2);
        buildScore = Math.max(0, 1.0 - (buildDiff / 4)); // Max diff is 4
    }

    let skinScore = 1.0;
    if (metadata1.skinTone && metadata2.skinTone && metadata1.skinTone !== 'unknown' && metadata2.skinTone !== 'unknown') {
        const skinMap = { 'very-light': 1, 'light': 2, 'medium': 3, 'tan': 4, 'brown': 5, 'dark': 6 };
        const skin1 = skinMap[metadata1.skinTone] || 3;
        const skin2 = skinMap[metadata2.skinTone] || 3;
        const skinDiff = Math.abs(skin1 - skin2);
        skinScore = Math.max(0, 1.0 - (skinDiff / 5)); // Max diff is 5
    }

    let hairScore = 1.0;
    if (metadata1.hairColor && metadata2.hairColor && metadata1.hairColor !== 'unknown' && metadata2.hairColor !== 'unknown') {
        hairScore = metadata1.hairColor === metadata2.hairColor ? 1.0 : 0.3;
    }

    // Weighted combination: age most important, then build, skin, hair
    const compatibilityScore = (
        ageScore * 0.4 +
        buildScore * 0.3 +
        skinScore * 0.15 +
        hairScore * 0.15
    );

    console.log(`Metadata compatibility: age=${(ageScore*100).toFixed(0)}%, build=${(buildScore*100).toFixed(0)}%, skin=${(skinScore*100).toFixed(0)}%, hair=${(hairScore*100).toFixed(0)}%, overall=${(compatibilityScore*100).toFixed(0)}%`);

    return compatibilityScore;
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
 * Update similarity bar based on current embeddings and metadata (two-stage)
 */
export function updateSimilarityBar() {
    const youEmbedding = descriptionState.you.embedding;
    const meEmbedding = descriptionState.me.embedding;
    const youMetadata = descriptionState.you.metadata;
    const meMetadata = descriptionState.me.metadata;

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

    // STAGE 1: Metadata compatibility check
    const metadataScore = checkMetadataCompatibility(youMetadata, meMetadata);

    if (metadataScore === 0.0) {
        // Fatal mismatch - display 0%
        if (dom.similarityBarFill) {
            dom.similarityBarFill.style.height = '0%';
        }
        if (dom.similarityPercentage) {
            dom.similarityPercentage.textContent = '0%';
        }
        console.log('Final similarity: 0% (metadata filter)');
        return;
    }

    // STAGE 2: Vector similarity (outfit matching)
    const rawVectorSimilarity = cosineSimilarity(youEmbedding, meEmbedding);

    if (rawVectorSimilarity === null) {
        console.warn('Failed to calculate vector similarity');
        return;
    }

    // Apply transformation to vector similarity
    const transformedVectorSimilarity = transformSimilarity(rawVectorSimilarity);

    // Combine metadata and vector scores
    // Metadata gates (30%), vector discriminates (70%)
    const combinedScore = metadataScore * 0.3 + transformedVectorSimilarity * 0.7;
    const percentage = Math.max(0, Math.min(100, combinedScore * 100));

    // Update bar height
    if (dom.similarityBarFill) {
        dom.similarityBarFill.style.height = `${percentage}%`;
    }

    // Update percentage text
    if (dom.similarityPercentage) {
        dom.similarityPercentage.textContent = `${Math.round(percentage)}%`;
    }

    console.log(`Similarity: vector=${(rawVectorSimilarity * 100).toFixed(1)}%, metadata=${(metadataScore * 100).toFixed(0)}%, final=${percentage.toFixed(1)}%`);
}

/**
 * Store embedding and metadata for a side and update similarity
 */
export function storeEmbedding(side, embedding, metadata = null) {
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
    state.metadata = metadata;
    
    if (metadata) {
        console.log(`Stored embedding and metadata for ${side}:`, {
            dimensions: embedding.length,
            gender: metadata.gender,
            ageRange: metadata.ageRange
        });
    } else {
        console.log(`Stored embedding for ${side} (${embedding.length} dimensions, no metadata)`);
    }

    // Update similarity bar
    updateSimilarityBar();
}

/**
 * Clear embedding and metadata for a side
 */
export function clearEmbedding(side) {
    const state = descriptionState[side];
    if (!state) return;

    state.embedding = null;
    state.metadata = null;
    updateSimilarityBar();
}

/**
 * Clear all embeddings and metadata
 */
export function clearAllEmbeddings() {
    descriptionState.you.embedding = null;
    descriptionState.you.metadata = null;
    descriptionState.me.embedding = null;
    descriptionState.me.metadata = null;
    updateSimilarityBar();
}

