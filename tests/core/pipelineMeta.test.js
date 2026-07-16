import test from 'node:test';
import assert from 'node:assert/strict';

import {
    attachTopNSelectionMeta,
    createAcceptedWatermarkMeta,
    createRejectedWatermarkMeta,
    createWatermarkMeta
} from '../../src/core/pipelineMeta.js';
import { createCandidateEvaluation } from '../../src/core/candidateEvaluation.js';

function createAlwaysPassingEvaluation() {
    return createCandidateEvaluation({
        source: 'standard',
        config: { logoSize: 48, marginRight: 32, marginBottom: 32 },
        provenance: {},
        originalScores: { spatialScore: 0.5, gradientScore: 0.2 },
        processedScores: { spatialScore: 0.05, gradientScore: 0.02 },
        improvement: 0.45,
        residual: { cleared: true },
        damage: { safe: true, penalty: 0.02 },
        gates: {
            originalEvidenceAllowed: true,
            catalogEvidenceAllowed: true,
            darkPolarityCatalogEvidenceAllowed: true,
            baseValidationAccepted: true
        }
    });
}

test('createWatermarkMeta should normalize skipped metadata', () => {
    const meta = createWatermarkMeta({
        position: { x: 1, y: 2, width: 48, height: 48 },
        config: { logoSize: 48, marginRight: 32, marginBottom: 32, ignored: true },
        processedSpatialScore: 0.1,
        processedGradientScore: 0.2,
        source: 'skipped',
        applied: false,
        skipReason: 'no-watermark-detected',
        passes: 'not-an-array'
    });

    assert.equal(meta.applied, false);
    assert.equal(meta.skipReason, 'no-watermark-detected');
    assert.equal(meta.size, 48);
    assert.deepEqual(meta.config, { logoSize: 48, marginRight: 32, marginBottom: 32 });
    assert.equal(meta.detection.processedSpatialScore, 0.1);
    assert.equal(meta.passes, null);
});

test('createAcceptedWatermarkMeta should attach accepted decision path', () => {
    const selectedTrial = {
        source: 'standard',
        config: { logoSize: 48, marginRight: 32, marginBottom: 32 },
        position: { x: 80, y: 80, width: 48, height: 48 },
        alphaGain: 1,
        originalSpatialScore: 0.6,
        originalGradientScore: 0.3,
        processedSpatialScore: 0.12,
        processedGradientScore: 0.05,
        improvement: 0.48,
        provenance: {},
        originalEvidence: { tier: 2 },
        residual: { cleared: true },
        damage: { safe: true, penalty: 0.02 },
        evaluation: createAlwaysPassingEvaluation()
    };

    const meta = createAcceptedWatermarkMeta({
        selectedTrial,
        selectionSource: 'standard',
        source: 'standard+edge-cleanup',
        decisionTier: 'direct-match',
        config: selectedTrial.config,
        position: selectedTrial.position,
        alphaGain: 1,
        passCount: 1,
        attemptedPassCount: 1,
        passStopReason: 'residual-low',
        passes: [{ index: 1 }],
        alphaAdjustmentStages: [{
            stage: 'known-48-edge-cleanup',
            fromAlphaGain: 1,
            toAlphaGain: 1,
            repairStrategy: 'edge-cleanup'
        }],
        processedSpatialScore: 0.08,
        processedGradientScore: 0.04,
        suppressionGain: 0.52
    });

    assert.equal(meta.applied, true);
    assert.equal(meta.decisionPath.decision, 'accept');
    assert.equal(meta.decisionPath.alphaTrial.alphaGain, 1);
    assert.equal(meta.decisionPath.repairTrial.applied, true);
    assert.equal(meta.decisionPath.repairTrial.params[0].repairStrategy, 'edge-cleanup');
    assert.equal(meta.passCount, 1);
    assert.deepEqual(meta.passes, [{ index: 1 }]);
});

test('createRejectedWatermarkMeta should attach rejected decision path', () => {
    const meta = createRejectedWatermarkMeta({
        reason: 'no-watermark-detected',
        adaptiveConfidence: 0.12,
        originalSpatialScore: 0.03,
        originalGradientScore: 0.04,
        decisionTier: 'insufficient'
    });

    assert.equal(meta.applied, false);
    assert.equal(meta.skipReason, 'no-watermark-detected');
    assert.equal(meta.detection.processedSpatialScore, 0.03);
    assert.equal(meta.detection.processedGradientScore, 0.04);
    assert.equal(meta.decisionPath.decision, 'reject');
    assert.equal(meta.decisionPath.blockedGate, 'no-watermark-detected');
    assert.equal(meta.decisionPath.evaluation.decision, 'reject');
});

test('createAcceptedWatermarkMeta should normalize best-effort selection fields', () => {
    const imageData = { width: 1, height: 1, data: new Uint8ClampedArray(4) };
    const alphaMap = new Float32Array([0.5]);
    const meta = createAcceptedWatermarkMeta({
        selectedTrial: {
            source: 'standard',
            config: { logoSize: 48, marginRight: 32, marginBottom: 32 },
            position: { x: 80, y: 80, width: 48, height: 48 }
        },
        source: 'standard+fine-alpha',
        config: { logoSize: 48, marginRight: 32, marginBottom: 32 },
        position: { x: 80, y: 80, width: 48, height: 48 },
        bestEffort: true,
        retryRecommended: false,
        qualityStatus: 'visible-residual',
        selectionConfidence: 1.5,
        selectedCandidate: {
            id: 'candidate-2',
            family: 'geometry',
            rank: 1,
            imageData,
            alphaMap
        },
        qualitySignals: { residualVisible: true, damageWarning: false },
        candidateSummaries: [{
            id: 'candidate-2',
            family: 'geometry',
            rank: 1,
            valid: true,
            finalScore: 0.2,
            imageData,
            alphaMap
        }]
    });

    assert.equal(meta.bestEffort, true);
    assert.equal(meta.retryRecommended, false);
    assert.equal(meta.qualityStatus, 'visible-residual');
    assert.equal(meta.selectionConfidence, 1);
    assert.equal(meta.selectedCandidate.id, 'candidate-2');
    assert.equal('imageData' in meta.selectedCandidate, false);
    assert.equal('alphaMap' in meta.selectedCandidate, false);
    assert.equal(meta.candidateSummaries.length, 1);
    assert.equal('imageData' in meta.candidateSummaries[0], false);
    assert.equal('alphaMap' in meta.candidateSummaries[0], false);
});

test('attachTopNSelectionMeta should preserve existing accepted metadata', () => {
    const existing = createWatermarkMeta({
        position: { x: 1, y: 2, width: 48, height: 48 },
        config: { logoSize: 48, marginRight: 32, marginBottom: 32 },
        processedSpatialScore: 0.1,
        processedGradientScore: 0.2,
        source: 'standard+gain',
        decisionPath: { decision: 'accept' }
    });

    const attached = attachTopNSelectionMeta(existing, {
        qualityStatus: 'clean',
        selectionConfidence: 0.8,
        selectedCandidate: { id: 'candidate-1', family: 'standard', rank: 1 },
        qualitySignals: { residualVisible: false, damageWarning: false },
        candidateSummaries: [{ id: 'candidate-1', rank: 1, valid: true }]
    });

    assert.notEqual(attached, existing);
    assert.deepEqual(attached.detection, existing.detection);
    assert.deepEqual(attached.decisionPath, existing.decisionPath);
    assert.equal(attached.bestEffort, true);
    assert.equal(attached.retryRecommended, false);
    assert.equal(attached.qualityStatus, 'clean');
});
