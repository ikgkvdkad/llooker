// Single-camera page initialization and selection storage

import { DEFAULT_BACK_ASPECT, SINGLE_SELECTIONS_STORE_URL, SINGLE_SELECTIONS_LIST_URL, SINGLE_SELECTIONS_CLEAR_URL, SINGLE_SELECTIONS_DELETE_URL } from './config.js';
import * as dom from './dom.js';
import { initializePhotoSlot, displayPhotoForSide } from './photo.js';
import { setupSelectionInteractions, updateSelectionStyles } from './selection.js';
import { updateCameraHalfAspect, stopAllCameras, openBackCamera, captureBackPhoto } from './camera.js';
import { renderAppVersion, showError, showWarning } from './ui.js';
import { snapshotViewportState } from './zoom.js';
import { photoSlots } from './state.js';
import { createViewportDataUrl, buildViewportSignature } from './analysis-api.js';
import { readFileAsDataUrl, loadImageElement } from './utils.js';
import {
    handlePointerDownOnHalf,
    handlePointerMoveOnHalf,
    handlePointerUpOnHalf,
    handlePointerCancelOnHalf,
    registerTapHandler
} from './interactions.js';

function assertConfigured(value, message) {
    if (!value) {
        showError(message, { diagnostics: false });
        throw new Error(message);
    }
}

function getSingleSelectionContainer() {
    if (!dom.galleryList) {
        // Single page has its own container
        const el = document.getElementById('singleSelectionList');
        if (!el) {
            console.warn('Single selection list container missing.');
        }
        return el;
    }
    return document.getElementById('singleSelectionList');
}

const singleGroupRows = new Map();
const singleSelectionSchemas = new Map();
const GROUPING_DETAILS_EMPTY_TEXT = 'Detailed score breakdown not available for this photo.';
const BEST_CANDIDATE_EMPTY_TEXT = 'Top-scoring group preview is not available for this photo yet.';
const DESCRIPTION_CLARITY_EMPTY_TEXT = 'Clarity score not available for this photo yet.';

const SINGLE_UPLOAD_LABEL = 'Subject';
const pendingSingleUploads = [];
let isProcessingSingleUpload = false;

function toOneDecimalLocal(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) {
        return null;
    }
    return Math.round(num * 10) / 10;
}

function deepClone(value) {
    if (!value || typeof value !== 'object') {
        return null;
    }
    try {
        return JSON.parse(JSON.stringify(value));
    } catch (error) {
        console.warn('Failed to clone grouping details payload.', error);
        return value;
    }
}

function normalizeClarityValue(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) {
        return null;
    }
    return Math.max(0, Math.min(100, Math.round(num)));
}
function buildContributionList(items) {
    if (!Array.isArray(items) || !items.length) {
        return null;
    }
    const list = document.createElement('ul');
    list.className = 'single-grouping-detail-list';
    items.forEach((item) => {
        const li = document.createElement('li');
        const label = document.createElement('span');
        label.className = 'category-label';
        const noteText = item?.note ? ` (${item.note})` : '';
        label.textContent = `${item?.category || 'unknown'}${noteText}`;
        const value = document.createElement('span');
        value.className = 'value-label';
        value.textContent = Number.isFinite(Number(item?.value))
            ? String(Math.round(Number(item.value)))
            : (item?.value ?? '-');
        li.append(label, value);
        list.appendChild(li);
    });
    return list;
}

function createDetailSection(title, content) {
    const section = document.createElement('div');
    section.className = 'single-grouping-detail-section';
    const heading = document.createElement('div');
    heading.className = 'single-grouping-detail-section-title';
    heading.textContent = title;
    section.appendChild(heading);
    if (typeof content === 'string') {
        const body = document.createElement('div');
        body.className = 'single-grouping-detail-body';
        body.textContent = content;
        section.appendChild(body);
    } else if (content instanceof Node) {
        section.appendChild(content);
    }
    return section;
}

function renderGroupingDetails(container, details) {
    if (!container) {
        return;
    }
    container.innerHTML = '';
    if (!details) {
        container.classList.add('is-empty');
        container.textContent = GROUPING_DETAILS_EMPTY_TEXT;
        return;
    }
    container.classList.remove('is-empty');
    const rawScores = details.rawScores || {};
    container.appendChild(createDetailSection(
        'Raw scores',
        `pro ${rawScores.pro ?? 'unknown'} vs contra ${rawScores.contra ?? 'unknown'}`
    ));

    const normalized = details.normalized || {};
    container.appendChild(createDetailSection(
        'Normalized',
        `normPro ${normalized.normPro ?? 'unknown'} / ≥${normalized.requiredNormPro ?? 'n/a'}, normContra ${normalized.normContra ?? 'unknown'} / ≤${normalized.requiredNormContra ?? 'n/a'}, probability ${normalized.probability ?? 'unknown'}%`
    ));

    const proList = buildContributionList(details.proContributions);
    container.appendChild(createDetailSection(
        'Supporting evidence',
        proList || 'No strong supporting cues were detected.'
    ));

    const contraList = buildContributionList(details.contraContributions);
    container.appendChild(createDetailSection(
        'Conflicting cues',
        contraList || 'No major conflicts were recorded.'
    ));

    if (details.clarity && (details.clarity.newImage !== null || details.clarity.canonical !== null)) {
        container.appendChild(createDetailSection(
            'Image clarity',
            `incoming ${details.clarity.newImage ?? 'unknown'} vs canonical ${details.clarity.canonical ?? 'unknown'}`
        ));
    }

    if (details.fallbackApplied) {
        container.appendChild(createDetailSection(
            'Override applied',
            details.fallbackReason === 'clarity_override'
                ? 'Accepted despite thresholds because the new photo is significantly clearer than the group reference.'
                : 'Accepted via fallback despite thresholds.'
        ));
    }
}

function renderBestCandidate(container, candidate, probabilityValue) {
    if (!container) {
        return;
    }
    container.innerHTML = '';
    if (!candidate) {
        container.classList.add('is-empty');
        container.textContent = BEST_CANDIDATE_EMPTY_TEXT;
        return;
    }

    container.classList.remove('is-empty');

    const label = document.createElement('div');
    label.className = 'single-best-candidate-label';
    const assigned = typeof probabilityValue === 'number' && probabilityValue > 0;
    label.textContent = assigned
        ? 'Assigned group summary'
        : 'Top scoring group (not assigned)';

    const body = document.createElement('div');
    body.className = 'single-best-candidate-body';

    const thumbWrap = document.createElement('div');
    thumbWrap.className = 'single-best-candidate-thumb-wrap';

    if (candidate.representativeImage) {
        const img = document.createElement('img');
        img.src = candidate.representativeImage;
        img.alt = 'Top scoring group reference';
        img.className = 'single-best-candidate-thumb';
        thumbWrap.appendChild(img);
    } else {
        const placeholder = document.createElement('div');
        placeholder.className = 'single-best-candidate-thumb placeholder';
        placeholder.textContent = 'No image';
        thumbWrap.appendChild(placeholder);
    }

    const meta = document.createElement('div');
    meta.className = 'single-best-candidate-meta';

    const lines = [
        candidate.groupId ? `Group ID: ${candidate.groupId}` : null,
        `Raw scores: pro ${candidate.proScore ?? 'n/a'} vs contra ${candidate.contraScore ?? 'n/a'}`,
        `Normalized: normPro ${candidate.normPro ?? 'n/a'}, normContra ${candidate.normContra ?? 'n/a'}, probability ${candidate.probability ?? 'n/a'}%`,
        `Members: ${candidate.memberCount ?? 0}`,
        candidate.fatalMismatchReason ? `Fatal mismatch: ${candidate.fatalMismatchReason}` : null,
        (candidate.newImageClarity !== null || candidate.groupClarity !== null)
            ? `Clarity: new ${candidate.newImageClarity ?? 'n/a'} vs canonical ${candidate.groupClarity ?? 'n/a'}`
            : null
    ].filter(Boolean);

    lines.forEach((line) => {
        const entry = document.createElement('div');
        entry.textContent = line;
        meta.appendChild(entry);
    });

    if (candidate.fallbackReason === 'clarity_override') {
        const note = document.createElement('div');
        note.textContent = 'Accepted via clarity override (new photo significantly clearer).';
        meta.appendChild(note);
    }

    if (candidate.representativeCapturedAt) {
        const timeEntry = document.createElement('div');
        timeEntry.textContent = `Captured: ${new Date(candidate.representativeCapturedAt).toLocaleString()}`;
        meta.appendChild(timeEntry);
    }

    body.append(thumbWrap, meta);
    container.append(label, body);
}

function serializeGroupingDetails(details) {
    if (!details) {
        return '';
    }
    try {
        return JSON.stringify(details);
    } catch (error) {
        console.warn('Failed to serialize grouping explanation details.', error);
        return '';
    }
}

function parseGroupingDetails(raw) {
    if (!raw) {
        return null;
    }
    try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && parsed.bestCandidate) {
            delete parsed.bestCandidate;
        }
        return parsed;
    } catch (error) {
        console.warn('Failed to parse grouping explanation details.', error);
        return null;
    }
}

function serializeBestCandidate(candidate) {
    if (!candidate) {
        return '';
    }
    try {
        return JSON.stringify(candidate);
    } catch (error) {
        console.warn('Failed to serialize best candidate summary.', error);
        return '';
    }
}

function parseBestCandidate(raw) {
    if (!raw) {
        return null;
    }
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (error) {
        console.warn('Failed to parse best candidate summary.', error);
        return null;
    }
}

function buildDescriptionGroupKey(description) {
    if (typeof description !== 'string') {
        return null;
    }

    const normalized = description
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\b(?:the|a|an|and|with|wearing|holding|carrying|while)\b/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    if (!normalized) {
        return null;
    }

    // Simple deterministic hash so similar descriptions map together.
    let hash = 0;
    for (let i = 0; i < normalized.length; i += 1) {
        hash = (hash * 31 + normalized.charCodeAt(i)) >>> 0;
    }

    return `desc-${normalized.slice(0, 48)}-${hash.toString(16)}`;
}

async function buildFullFrameViewportSnapshot(photoDataUrl) {
    const image = await loadImageElement(photoDataUrl);
    const naturalWidth = image?.naturalWidth || image?.width || 0;
    const naturalHeight = image?.naturalHeight || image?.height || 0;

    if (!naturalWidth || !naturalHeight) {
        throw new Error('Uploaded photo dimensions unavailable.');
    }

    const devicePixelRatio = window.devicePixelRatio && Number.isFinite(window.devicePixelRatio)
        ? Math.max(1, window.devicePixelRatio)
        : 1;

    return {
        containerWidth: naturalWidth,
        containerHeight: naturalHeight,
        naturalWidth,
        naturalHeight,
        objectFit: 'contain',
        transform: {
            scale: 1,
            translateX: 0,
            translateY: 0
        },
        devicePixelRatio,
        selection: {
            x: 0,
            y: 0,
            width: 1,
            height: 1
        }
    };
}

function renderSelectionRow(selection) {
    const container = getSingleSelectionContainer();
    if (!container || !selection?.imageDataUrl) {
        return;
    }

    const descriptionKey = buildDescriptionGroupKey(selection.description);
    let groupKey;
    if (selection.personGroupId) {
        groupKey = `group-${selection.personGroupId}`;
    } else if (descriptionKey) {
        groupKey = descriptionKey;
    } else if (selection.id) {
        groupKey = `selection-${selection.id}`;
        console.warn('Selection missing grouping metadata; falling back to unique row.', selection);
    } else {
        groupKey = `selection-${crypto.randomUUID?.() || Math.random()}`;
        console.warn('Selection missing grouping metadata and id; using random row key.', selection);
    }

    let row = singleGroupRows.get(groupKey);
    if (!row) {
        row = document.createElement('div');
        row.className = 'single-selection-row';
        row.dataset.groupKey = groupKey;
        row.dataset.groupSource = selection.personGroupId ? 'personGroupId' : descriptionKey ? 'description' : 'selectionId';
        singleGroupRows.set(groupKey, row);
        container.appendChild(row);
    }

    const groupingProbabilityValue = Number.isFinite(Number(selection.groupingProbability))
        ? Math.max(0, Math.min(100, Number(selection.groupingProbability)))
        : null;
    const groupingExplanationText = typeof selection.groupingExplanation === 'string'
        ? selection.groupingExplanation.trim()
        : '';
    const groupingExplanationDetails = selection.groupingExplanationDetails || null;
    const rawClarity = Number.isFinite(Number(selection.descriptionClarity))
        ? Number(selection.descriptionClarity)
        : Number(selection.descriptionSchema?.image_clarity);
    const descriptionClarity = normalizeClarityValue(rawClarity);
    let detailPayload = deepClone(groupingExplanationDetails);
    let bestCandidateSummary = selection.bestCandidate || null;
    if (detailPayload && typeof detailPayload === 'object' && detailPayload.bestCandidate) {
        bestCandidateSummary = bestCandidateSummary || detailPayload.bestCandidate;
        delete detailPayload.bestCandidate;
    }

    const wrapper = document.createElement('div');
    wrapper.className = 'single-selection-thumb-wrapper';
    if (selection.description && selection.description.length > 0) {
        wrapper.classList.add('has-description');
    }
    if (selection.id) {
        wrapper.dataset.selectionId = String(selection.id);
    }
    wrapper.dataset.description = selection.description || '';
    wrapper.dataset.groupingProbability = groupingProbabilityValue !== null
        ? String(groupingProbabilityValue)
        : '';
    wrapper.dataset.groupingExplanation = groupingExplanationText || '';
    wrapper.dataset.groupingDetails = serializeGroupingDetails(detailPayload);
    wrapper.dataset.bestCandidate = serializeBestCandidate(bestCandidateSummary);
    wrapper.dataset.descriptionClarity = descriptionClarity !== null ? String(descriptionClarity) : '';
    wrapper.dataset.personGroupId = selection.personGroupId
        ? String(selection.personGroupId)
        : '';

    const img = document.createElement('img');
    img.className = 'single-selection-thumb';
    img.src = selection.imageDataUrl;
    img.alt = 'Saved selection';
    img.loading = 'lazy';

    wrapper.appendChild(img);

    if (selection.capturedAt || selection.createdAt) {
        const meta = document.createElement('div');
        meta.className = 'single-selection-meta';
        const timestamp = selection.capturedAt || selection.createdAt;
        meta.textContent = timestamp ? new Date(timestamp).toLocaleString() : '';
        wrapper.appendChild(meta);
    }

    row.appendChild(wrapper);

    // Cache structured schema for this selection if available.
    if (selection.id && selection.descriptionSchema && typeof selection.descriptionSchema === 'object') {
        singleSelectionSchemas.set(Number(selection.id), selection.descriptionSchema);
    }

    const openDescription = async () => {
        const modal = document.getElementById('singleDescriptionModal');
        const textEl = document.getElementById('singleDescriptionText');
        const clarityEl = document.getElementById('singleDescriptionClarity');
        const probabilityEl = document.getElementById('singleGroupingProbability');
        const explanationEl = document.getElementById('singleGroupingExplanation');
        const breakdownEl = document.getElementById('singleGroupingDetails');
        const bestCandidateEl = document.getElementById('singleBestCandidate');
        const groupIdEl = document.getElementById('singleGroupingId');
        const neighborsEl = document.getElementById('singleDescriptionNeighbors');
        const structuredEl = document.getElementById('singleDescriptionStructured');

        if (!modal || !textEl || !probabilityEl || !explanationEl || !groupIdEl || !neighborsEl || !structuredEl || !breakdownEl || !bestCandidateEl || !clarityEl) {
            showWarning('Description viewer is missing required fields. Reload the page and try again.', {
                diagnostics: false
            });
            return;
        }

        const description = wrapper.dataset.description || '';
        if (!description) {
            showWarning('Description not available for this photo. Capture a new photo to generate one.', {
                diagnostics: false
            });
            return;
        }

        textEl.textContent = description;
        const clarityValue = normalizeClarityValue(wrapper.dataset.descriptionClarity || '');
        if (clarityValue !== null) {
            clarityEl.textContent = `Clarity score: ${clarityValue} / 100`;
            clarityEl.classList.remove('is-empty');
        } else {
            clarityEl.textContent = DESCRIPTION_CLARITY_EMPTY_TEXT;
            clarityEl.classList.add('is-empty');
        }

        const probabilityRaw = wrapper.dataset.groupingProbability || '';
        const probabilityValue = Number.isFinite(Number(probabilityRaw))
            ? Math.max(0, Math.min(100, Math.round(Number(probabilityRaw))))
            : null;
        if (probabilityValue !== null) {
            probabilityEl.textContent = `${probabilityValue}% match likelihood`;
            probabilityEl.classList.remove('is-empty');
        } else {
            probabilityEl.textContent = 'Grouping probability not available for this photo yet.';
            probabilityEl.classList.add('is-empty');
        }

        const explanationText = (wrapper.dataset.groupingExplanation || '').trim();
        if (explanationText) {
            explanationEl.textContent = explanationText;
            explanationEl.classList.remove('is-empty');
        } else {
            explanationEl.textContent = 'Grouping explanation not available for this photo yet.';
            explanationEl.classList.add('is-empty');
        }

        const detailsRaw = wrapper.dataset.groupingDetails || '';
        const explanationDetails = parseGroupingDetails(detailsRaw);
        renderGroupingDetails(breakdownEl, explanationDetails);

        const bestCandidateRaw = wrapper.dataset.bestCandidate || '';
        const bestCandidateSummary = parseBestCandidate(bestCandidateRaw) || null;
        renderBestCandidate(bestCandidateEl, bestCandidateSummary, probabilityValue);

        const groupIdText = (wrapper.dataset.personGroupId || '').trim();
        if (groupIdText) {
            groupIdEl.textContent = `Group ID: ${groupIdText}`;
            groupIdEl.classList.remove('is-empty');
        } else {
            groupIdEl.textContent = 'Group ID not available for this photo yet.';
            groupIdEl.classList.add('is-empty');
        }

        // Nearest groups by appearance for this selection.
        neighborsEl.innerHTML = '';
        const selectionIdText = wrapper.dataset.selectionId || '';
        const selectionId = Number.isFinite(Number(selectionIdText)) ? Number(selectionIdText) : null;

        const label = document.createElement('div');
        label.className = 'single-description-neighbors-label';
        label.textContent = 'Closest groups by appearance';
        neighborsEl.appendChild(label);

        const content = document.createElement('div');
        content.className = 'single-description-neighbors-list';
        neighborsEl.appendChild(content);

        if (!selectionId) {
            const msg = document.createElement('div');
            msg.className = 'single-description-neighbor-meta';
            msg.textContent = 'Scoring details are not available for this thumbnail (missing id).';
            content.appendChild(msg);
        } else {
            const loading = document.createElement('div');
            loading.className = 'single-description-neighbor-meta';
            loading.textContent = 'Loading closest groups…';
            content.appendChild(loading);

            try {
                const response = await fetch(`/.netlify/functions/get-single-group-neighbors?id=${encodeURIComponent(selectionId)}`);
                if (!response.ok) {
                    const errorText = await response.text().catch(() => '');
                    throw new Error(errorText || `HTTP ${response.status}`);
                }
                const payload = await response.json().catch(() => ({}));
                const neighbors = Array.isArray(payload?.neighbors) ? payload.neighbors : [];

                content.innerHTML = '';

                if (!neighbors.length) {
                    const msg = document.createElement('div');
                    msg.className = 'single-description-neighbor-meta';
                    msg.textContent = 'No strong group matches found for this photo yet.';
                    content.appendChild(msg);
                } else {
                    neighbors.slice(0, 3).forEach((neighbor) => {
                        const card = document.createElement('div');
                        card.className = 'single-description-neighbor-card';

                        if (neighbor.imageDataUrl) {
                            const thumb = document.createElement('img');
                            thumb.className = 'single-description-neighbor-thumb';
                            thumb.src = neighbor.imageDataUrl;
                            thumb.alt = `Group ${neighbor.personGroupId || ''} representative photo`;
                            card.appendChild(thumb);
                        }

                        const meta = document.createElement('div');
                        meta.className = 'single-description-neighbor-meta';

                        const header = document.createElement('strong');
                        const scoreValue = Number.isFinite(Number(neighbor.score))
                            ? Math.max(0, Math.min(100, Math.round(Number(neighbor.score))))
                            : null;
                        if (neighbor.personGroupId && scoreValue !== null) {
                            header.textContent = `Group ${neighbor.personGroupId} · ${scoreValue}% similarity`;
                        } else if (neighbor.personGroupId) {
                            header.textContent = `Group ${neighbor.personGroupId}`;
                        } else if (scoreValue !== null) {
                            header.textContent = `${scoreValue}% similarity`;
                        } else {
                            header.textContent = 'Group match';
                        }
                        meta.appendChild(header);

                        const explanation = (neighbor.explanation || '').trim();
                        if (explanation) {
                            const expl = document.createElement('div');
                            expl.className = 'single-description-neighbor-explanation';
                            expl.textContent = explanation;
                            meta.appendChild(expl);
                        }

                        const timestamp = neighbor.capturedAt || neighbor.createdAt || null;
                        if (timestamp) {
                            const tsEl = document.createElement('div');
                            tsEl.className = 'single-description-neighbor-timestamp';
                            try {
                                const date = new Date(timestamp);
                                tsEl.textContent = date.toLocaleString();
                            } catch {
                                tsEl.textContent = String(timestamp);
                            }
                            meta.appendChild(tsEl);
                        }

                        card.appendChild(meta);
                        content.appendChild(card);
                    });
                }
            } catch (error) {
                console.error('Failed to load single-group neighbors:', error);
                content.innerHTML = '';
                const msg = document.createElement('div');
                msg.className = 'single-description-neighbor-meta';
                msg.textContent = 'Scoring details could not be loaded for this photo. Check diagnostics.';
                content.appendChild(msg);
            }
        }

        // Structured variables from the full description schema.
        structuredEl.innerHTML = '';
        const structuredLabel = document.createElement('div');
        structuredLabel.className = 'single-description-structured-label';
        structuredLabel.textContent = 'Structured variables';
        structuredEl.appendChild(structuredLabel);

        const schema = selectionId ? singleSelectionSchemas.get(selectionId) : null;
        if (schema) {
            const pre = document.createElement('pre');
            pre.className = 'single-description-structured-pre';
            try {
                pre.textContent = JSON.stringify(schema, null, 2);
            } catch {
                pre.textContent = '[Unable to render structured variables]';
            }
            structuredEl.appendChild(pre);
        } else {
            const msg = document.createElement('div');
            msg.className = 'single-description-neighbor-meta';
            msg.textContent = 'Structured variables are not available for this photo yet.';
            structuredEl.appendChild(msg);
        }

        modal.classList.add('is-open');
        modal.setAttribute('aria-hidden', 'false');
    };

    const deleteSelection = async () => {
        const selectionId = wrapper.dataset.selectionId ? Number(wrapper.dataset.selectionId) : null;
        assertConfigured(
            SINGLE_SELECTIONS_DELETE_URL,
            'Single selections API (delete) is not configured.'
        );

        if (!selectionId) {
            console.warn('Cannot delete selection without a valid id.', wrapper);
            return;
        }

        try {
            const response = await fetch(SINGLE_SELECTIONS_DELETE_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ id: selectionId })
            });

            if (!response.ok) {
                const errorText = await response.text().catch(() => '');
                throw new Error(errorText || `HTTP ${response.status}`);
            }

            const rowEl = wrapper.parentElement;
            wrapper.remove();

            if (rowEl && !rowEl.querySelector('.single-selection-thumb-wrapper')) {
                const groupKey = rowEl.dataset.groupKey;
                rowEl.remove();
                if (groupKey && singleGroupRows.has(groupKey)) {
                    singleGroupRows.delete(groupKey);
                }
            }
        } catch (error) {
            console.error('Failed to delete single selection:', error);
            showError('Failed to delete this photo. Check diagnostics and try again.', {
                diagnostics: false,
                detail: error?.message || null
            });
        }
    };

    const LONG_PRESS_MS = 650;
    let longPressTimerId = null;
    let longPressTriggered = false;
    let activePointerId = null;

    const clearLongPressTimer = () => {
        if (longPressTimerId !== null) {
            window.clearTimeout(longPressTimerId);
            longPressTimerId = null;
        }
    };

    const handlePointerDown = (event) => {
        if (event.pointerType !== 'touch') {
            return;
        }
        activePointerId = event.pointerId;
        longPressTriggered = false;
        clearLongPressTimer();
        longPressTimerId = window.setTimeout(() => {
            longPressTriggered = true;
            longPressTimerId = null;
            void deleteSelection();
        }, LONG_PRESS_MS);
    };

    const handlePointerEnd = (event) => {
        if (event.pointerId !== activePointerId) {
            return;
        }
        if (event.pointerType === 'touch') {
            event.preventDefault();
        }
        clearLongPressTimer();
        const wasLongPress = longPressTriggered;
        activePointerId = null;

        if (!wasLongPress && event.pointerType === 'touch') {
            // Treat as a short tap -> open description
            void openDescription();
        }
    };

    wrapper.addEventListener('pointerdown', handlePointerDown);
    wrapper.addEventListener('pointerup', handlePointerEnd);
    wrapper.addEventListener('pointercancel', handlePointerEnd);
    wrapper.addEventListener('pointerleave', handlePointerEnd);

    // Desktop/mouse: regular click opens description
    wrapper.addEventListener('click', (event) => {
        if (event.pointerType === 'mouse' || typeof event.pointerType === 'undefined') {
            void openDescription();
        }
    });
}

async function loadExistingSelections() {
    if (!SINGLE_SELECTIONS_LIST_URL) {
        // Missing configuration should be explicit, no silent fallbacks
        showWarning('Single selections API (list) is not configured. Saved thumbnails will not load.', {
            diagnostics: false
        });
        return;
    }

    try {
        const response = await fetch(`${SINGLE_SELECTIONS_LIST_URL}?limit=200&offset=0`);
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        const payload = await response.json();
        const selections = Array.isArray(payload?.selections) ? payload.selections : [];

        const container = getSingleSelectionContainer();
        if (!container) {
            return;
        }
        container.innerHTML = '';
        singleGroupRows.clear();

        selections.forEach((selection) => {
            renderSelectionRow(selection);
        });
    } catch (error) {
        console.error('Failed to load single-camera selections:', error);
        showWarning('Unable to load previously saved selections.', {
            diagnostics: false,
            detail: error?.message || null
        });
    }
}

async function saveCurrentSelection({ viewportOverride = null } = {}) {
    assertConfigured(
        SINGLE_SELECTIONS_STORE_URL,
        'Single selections API (store) is not configured.'
    );

    const slot = photoSlots.back;
    if (!slot || typeof slot.lastPhotoDataUrl !== 'string' || !slot.lastPhotoDataUrl.length) {
        showWarning('Capture a photo before saving a selection.', { diagnostics: false });
        return;
    }

    const viewport = viewportOverride || snapshotViewportState('back');
    if (!viewport) {
        const message = viewportOverride
            ? 'Uploaded photo is still loading. Wait a moment and try again.'
            : 'Viewing area is still stabilizing. Adjust the frame and try saving again.';
        showWarning(message, { diagnostics: false });
        return;
    }

    // For the single page we treat the zoomed view as the selection:
    // always use the full viewport, no visible selection box.
    const viewportForSave = {
        ...viewport,
        selection: {
            x: 0,
            y: 0,
            width: 1,
            height: 1
        }
    };

    let croppedDataUrl;
    try {
        croppedDataUrl = await createViewportDataUrl(slot.lastPhotoDataUrl, viewportForSave);
    } catch (error) {
        console.error('Failed to render viewport for single selection:', error);
        showError('Failed to render the selected area for saving.', {
            diagnostics: false,
            detail: error?.message || null
        });
        return;
    }

    const signature = buildViewportSignature(slot.lastPhotoDataUrl, viewportForSave);
    const capturedAtIso = new Date().toISOString();

    const payload = {
        imageDataUrl: croppedDataUrl,
        viewport: viewportForSave,
        signature,
        capturedAt: capturedAtIso,
        mode: 'single'
    };

    try {
        const response = await fetch(SINGLE_SELECTIONS_STORE_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const errorText = await response.text().catch(() => '');
            throw new Error(errorText || `HTTP ${response.status}`);
        }

        const result = await response.json().catch(() => ({}));
        if (result && result.groupingDebug) {
            console.log('single-page grouping (save)', result.groupingDebug);
        }
        const selectionMeta = result?.selection || {};

        renderSelectionRow({
            id: selectionMeta.id || null,
            personGroupId: selectionMeta.personGroupId || null,
            imageDataUrl: croppedDataUrl,
            createdAt: selectionMeta.createdAt || null,
            capturedAt: selectionMeta.capturedAt || capturedAtIso,
            description: selectionMeta.description || '',
            descriptionSchema: selectionMeta.descriptionSchema || null,
            groupingProbability: Number.isFinite(Number(selectionMeta.groupingProbability))
                ? Number(selectionMeta.groupingProbability)
                : null,
            groupingExplanation: selectionMeta.groupingExplanation || null,
            groupingExplanationDetails: selectionMeta.groupingExplanationDetails || null,
            bestCandidate: selectionMeta.bestCandidate || null
        });
    } catch (error) {
        console.error('Failed to store single-camera selection:', error);
        showError('Failed to save selection. Check diagnostics and try again.', {
            diagnostics: false,
            detail: error?.message || null
        });
    }
}

async function clearAllSelections() {
    assertConfigured(
        SINGLE_SELECTIONS_CLEAR_URL,
        'Single selections API (clear) is not configured.'
    );

    const clearButton = document.getElementById('singleClearButton');
    const originalLabel = clearButton ? clearButton.textContent : null;
    const setButtonBusy = (isBusy) => {
        if (!clearButton) {
            return;
        }
        if (isBusy) {
            if (!clearButton.dataset.originalLabel) {
                clearButton.dataset.originalLabel = originalLabel || clearButton.textContent || 'Clear';
            }
            clearButton.disabled = true;
            clearButton.setAttribute('aria-busy', 'true');
            clearButton.textContent = 'Clearing...';
        } else {
            clearButton.disabled = false;
            clearButton.removeAttribute('aria-busy');
            const label = clearButton.dataset.originalLabel || originalLabel;
            if (label) {
                clearButton.textContent = label;
            }
            delete clearButton.dataset.originalLabel;
        }
    };

    try {
        setButtonBusy(true);
        const response = await fetch(SINGLE_SELECTIONS_CLEAR_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            const errorText = await response.text().catch(() => '');
            console.error('clearAllSelections: API call failed', {
                status: response.status,
                statusText: response.statusText,
                body: errorText
            });
            throw new Error(errorText || `HTTP ${response.status}`);
        }

        const payload = await response.json().catch(() => null);
        if (!payload || payload.status !== 'ok') {
            console.error('clearAllSelections: malformed response payload', { payload });
            throw new Error(payload?.error || 'Malformed response from clear API.');
        }

        const singleInfo = (payload?.tables && payload.tables.single) || {};
        const analysesInfo = (payload?.tables && payload.tables.analyses) || {};
        const singleRemovedRaw = singleInfo.rowsCleared;
        const analysesRemovedRaw = analysesInfo.rowsCleared;
        const singleRemoved = Number.isFinite(Number(singleRemovedRaw)) ? Number(singleRemovedRaw) : null;
        const analysesRemoved = Number.isFinite(Number(analysesRemovedRaw)) ? Number(analysesRemovedRaw) : null;
        const singleTruncated = Boolean(singleInfo.truncated);
        const analysesTruncated = Boolean(analysesInfo.truncated);
        const analysesExists = analysesInfo.exists !== false;

        const container = getSingleSelectionContainer();
        if (container) {
            container.innerHTML = '';
        }

        const describeCount = (count, noun) => {
            if (typeof count === 'number' && Number.isFinite(count)) {
                return `${count} ${noun}${count === 1 ? '' : 's'}`;
            }
            return `all ${noun}s (count unavailable due to DB permissions)`;
        };

        const summaryParts = [];
        if (singleTruncated) {
            summaryParts.push(
                `Reset ${describeCount(singleRemoved, 'single selection')} (IDs restarted)`
            );
        } else {
            summaryParts.push(
                `Deleted ${describeCount(singleRemoved, 'single selection')} (IDs not reset)`
            );
        }

        if (analysesExists) {
            if (analysesTruncated) {
                summaryParts.push(
                    `reset ${describeCount(analysesRemoved, 'canonical description record')}`
                );
            } else {
                summaryParts.push(
                    `deleted ${describeCount(analysesRemoved, 'canonical description record')} (IDs not reset)`
                );
            }
        } else {
            summaryParts.push('canonical description table not found on database; skipped reset.');
        }

        showWarning(`Database wipe complete: ${summaryParts.join('; ')}.`, {
            diagnostics: false
        });
    } catch (error) {
        console.error('Failed to clear single-camera selections:', error);
        showError('Failed to clear selections. Check diagnostics and try again.', {
            diagnostics: false,
            detail: error?.message || null
        });
    } finally {
        setButtonBusy(false);
    }
}

function handleSingleUpload(fileInput) {
    const files = Array.from(fileInput.files || []);
    if (!files.length) {
        return;
    }

    fileInput.value = '';
    enqueueSingleUploads(files);
}

function enqueueSingleUploads(files) {
    const validFiles = files.filter(Boolean);
    if (!validFiles.length) {
        return;
    }

    pendingSingleUploads.push(...validFiles);

    if (!isProcessingSingleUpload) {
        void processSingleUploadQueue();
    }
}

async function processSingleUploadQueue() {
    if (isProcessingSingleUpload) {
        return;
    }

    isProcessingSingleUpload = true;
    try {
        while (pendingSingleUploads.length > 0) {
            const nextFile = pendingSingleUploads.shift();
            // eslint-disable-next-line no-await-in-loop
            await processSingleUploadFile(nextFile);
        }
    } finally {
        isProcessingSingleUpload = false;
    }
}

async function processSingleUploadFile(file) {
    if (!file) {
        return;
    }

    if (file.type && !file.type.startsWith('image/')) {
        const message = `${SINGLE_UPLOAD_LABEL} upload failed: selected file is not an image.`;
        console.warn(message);
        showError(message, { diagnostics: false });
        return;
    }

    try {
        const dataUrl = await readFileAsDataUrl(file);
        if (typeof dataUrl !== 'string' || !dataUrl.length) {
            throw new Error('Uploaded image data unavailable.');
        }
        displayPhotoForSide('you', dataUrl);
        stopAllCameras();
        const viewportOverride = await buildFullFrameViewportSnapshot(dataUrl);
        await saveCurrentSelection({ viewportOverride });
    } catch (error) {
        console.error(`${SINGLE_UPLOAD_LABEL} photo upload failed (single page):`, error);
        const message = `${SINGLE_UPLOAD_LABEL} upload failed: ${error?.message || 'Unable to process image.'}`;
        showError(message, {
            diagnostics: false,
            detail: error?.stack || null
        });
    }
}

function attachSingleUploadHandler(button, input) {
    if (!button || !input) {
        showWarning('Upload controls missing on single camera page.', { diagnostics: false });
        return;
    }

    const triggerInputSelection = () => {
        input.click();
    };

    let suppressNextClick = false;
    let suppressTimerId = null;

    const clearSuppressTimer = () => {
        if (suppressTimerId !== null) {
            window.clearTimeout(suppressTimerId);
            suppressTimerId = null;
        }
    };

    button.addEventListener('click', (event) => {
        if (suppressNextClick) {
            suppressNextClick = false;
            clearSuppressTimer();
            return;
        }
        triggerInputSelection();
    });

    button.addEventListener('pointerup', (event) => {
        if (event.pointerType === 'touch') {
            event.preventDefault();
            suppressNextClick = true;
            clearSuppressTimer();
            suppressTimerId = window.setTimeout(() => {
                suppressNextClick = false;
                suppressTimerId = null;
            }, 300);
            triggerInputSelection();
        }
    });

    input.addEventListener('change', () => {
        void handleSingleUpload(input);
    });
}

function openSingleCameraModal() {
    const modal = document.getElementById('singleCameraModal');
    if (!modal) {
        showError('Single camera modal missing in DOM.', { diagnostics: false });
        return;
    }

    document.body.classList.add('single-camera-active');

    modal.classList.add('is-open');
    modal.setAttribute('aria-hidden', 'false');

    const fullscreenTarget = modal.querySelector('.camera-container') || modal;
    if (fullscreenTarget && typeof fullscreenTarget.requestFullscreen === 'function') {
        fullscreenTarget.requestFullscreen().catch((error) => {
            console.warn('Fullscreen camera request failed:', error);
        });
    } else {
        console.warn('Fullscreen API not available for single camera modal.');
    }

    // Try to start the back camera immediately so the first tap captures
    openBackCamera().catch(error => {
        console.error('Failed to open back camera (single page):', error);
        showError('Failed to open back camera. Check camera permissions and try again.', {
            diagnostics: false,
            detail: error?.message || null
        });
    });
}

function closeSingleCameraModal() {
    const modal = document.getElementById('singleCameraModal');
    if (!modal) {
        return;
    }
    modal.classList.remove('is-open');
    modal.setAttribute('aria-hidden', 'true');

    document.body.classList.remove('single-camera-active');

    if (document.fullscreenElement && typeof document.exitFullscreen === 'function') {
        document.exitFullscreen().catch((error) => {
            console.warn('Exiting fullscreen failed:', error);
        });
    }
    // Reset camera slot after closing
    initializePhotoSlot('back');
    stopAllCameras();
}

function closeSingleDescriptionModal() {
    const modal = document.getElementById('singleDescriptionModal');
    if (!modal) {
        return;
    }
    modal.classList.remove('is-open');
    modal.setAttribute('aria-hidden', 'true');
}

function attachCameraModalHandlers() {
    const modal = document.getElementById('singleCameraModal');
    const overlay = document.getElementById('singleCameraOverlay');

    if (overlay && modal) {
        overlay.addEventListener('click', () => {
            closeSingleCameraModal();
        });
    }

    const descriptionOverlay = document.getElementById('singleDescriptionOverlay');
    if (descriptionOverlay) {
        descriptionOverlay.addEventListener('click', () => {
            closeSingleDescriptionModal();
        });
    }

    const descriptionCloseButton = document.getElementById('singleDescriptionCloseButton');
    if (descriptionCloseButton) {
        descriptionCloseButton.addEventListener('click', (event) => {
            event.preventDefault();
            closeSingleDescriptionModal();
        });
    }

    // Use tap gestures on the camera half to start/capture instead of a visible button
    registerTapHandler('back', ({ isActive }) => {
        const cameraModal = document.getElementById('singleCameraModal');
        if (!cameraModal || !cameraModal.classList.contains('is-open')) {
            // Not in single camera modal context; fall back to default behavior.
            return false;
        }

        // When the camera modal is open we treat any tap as capture:
        // camera should already be active from openSingleCameraModal.
        if (isActive) {
            captureBackPhoto();
            window.setTimeout(() => {
                void saveCurrentSelection();
                closeSingleCameraModal();
            }, 0);
            return true;
        }

        return false;
    });
}

function initSinglePage() {
    // Set default aspect ratio for back camera
    updateCameraHalfAspect('back', DEFAULT_BACK_ASPECT);

    // Pointer interactions for zoom/pan (within modal)
    if (dom.backCameraHalf) {
        dom.backCameraHalf.addEventListener('pointerdown', (event) => handlePointerDownOnHalf('back', event));
        dom.backCameraHalf.addEventListener('pointermove', (event) => handlePointerMoveOnHalf('back', event));
        dom.backCameraHalf.addEventListener('pointerup', (event) => handlePointerUpOnHalf('back', event));
        dom.backCameraHalf.addEventListener('pointercancel', (event) => handlePointerCancelOnHalf('back', event));
        dom.backCameraHalf.addEventListener('pointerleave', (event) => handlePointerCancelOnHalf('back', event));
    }

    // Cleanup cameras on unload
    window.addEventListener('beforeunload', () => {
        stopAllCameras();
    });

    // Selection interactions for the single slot
    setupSelectionInteractions('back');
    updateSelectionStyles('back');
    initializePhotoSlot('back');

    // Camera modal handlers
    attachCameraModalHandlers();

    // Toolbar camera open button
    const openCameraButton = document.getElementById('singleOpenCameraButton');
    if (openCameraButton) {
        openCameraButton.addEventListener('click', () => {
            openSingleCameraModal();
            // Camera will start on first tap inside the modal
        });
    }

    // Upload button behavior (single page variant)
    const uploadButton = document.getElementById('youUploadButton');
    const uploadInput = document.getElementById('youUploadInput');
    attachSingleUploadHandler(uploadButton, uploadInput);

    // Clear-all button
    const clearButton = document.getElementById('singleClearButton');
    if (clearButton) {
        clearButton.addEventListener('click', () => {
            void clearAllSelections();
        });
    }

    // Render version badge
    renderAppVersion();

    // Load existing selections for this collection
    void loadExistingSelections();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initSinglePage);
} else {
    initSinglePage();
}


