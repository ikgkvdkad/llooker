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

    // Calculate age compatibility (lenient for AI estimation errors, strict for large gaps)
    let ageScore = 1.0;
    if (metadata1.ageRange && metadata2.ageRange) {
        const parseAgeRange = (range) => {
            const parts = range.split('-').map(p => parseInt(p.trim()));
            return { min: parts[0] || 0, max: parts[1] || parts[0] || 100 };
        };

        const age1 = parseAgeRange(metadata1.ageRange);
        const age2 = parseAgeRange(metadata2.ageRange);

        // Calculate midpoints for distance-based scoring
        const mid1 = (age1.min + age1.max) / 2;
        const mid2 = (age2.min + age2.max) / 2;
        const distance = Math.abs(mid1 - mid2);

        // Steeper penalties for large age gaps:
        // 0-5 years apart = 100% (AI estimation margin)
        // 5-10 years apart = 85-100% (still likely same person)
        // 10-20 years apart = 25-85% (steep decline)
        // 20+ years apart = 5-25% (near-fatal, very unlikely)
        if (distance <= 5) {
            ageScore = 1.0;
        } else if (distance <= 10) {
            ageScore = 1.0 - ((distance - 5) / 5) * 0.15; // 100% -> 85%
        } else if (distance <= 20) {
            ageScore = 0.85 - ((distance - 10) / 10) * 0.6; // 85% -> 25%
        } else {
            ageScore = Math.max(0.05, 0.25 - ((distance - 20) / 20) * 0.2); // 25% -> 5%
        }

        console.log(`Age compatibility: ${metadata1.ageRange} vs ${metadata2.ageRange}, distance=${distance.toFixed(1)}y, score=${(ageScore*100).toFixed(0)}%`);
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
    let compatibilityScore = (
        ageScore * 0.4 +
        buildScore * 0.3 +
        skinScore * 0.15 +
        hairScore * 0.15
    );

    // Compound penalty: Multiple mismatches suggest different people
    // Count how many fields are significantly different (< 60%)
    const significantMismatches = [
        ageScore < 0.6 ? 1 : 0,
        buildScore < 0.6 ? 1 : 0,
        skinScore < 0.6 ? 1 : 0,
        hairScore < 0.6 ? 1 : 0
    ].reduce((a, b) => a + b, 0);

    // Apply exponential penalty for multiple mismatches
    if (significantMismatches >= 2) {
        const compoundPenalty = Math.pow(0.7, significantMismatches - 1);
        compatibilityScore *= compoundPenalty;
        console.log(`Compound penalty applied: ${significantMismatches} mismatches, penalty=${(compoundPenalty*100).toFixed(0)}%`);
    }

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
    
    // Normalize to 0-1 range (assuming min similarity of 0.35)
    const normalized = Math.max(0, (rawSimilarity - 0.35) / 0.65);
    
    // Apply power function to exaggerate differences
    // Power of 2.2 makes differences even more dramatic
    // This heavily penalizes partial matches (different outfits)
    const transformed = Math.pow(normalized, 2.2);
    
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
    // Outfit should dominate: metadata gates (15%), vector discriminates (85%)
    // This ensures different outfits result in low similarity even with compatible metadata
    const combinedScore = metadataScore * 0.15 + transformedVectorSimilarity * 0.85;
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

