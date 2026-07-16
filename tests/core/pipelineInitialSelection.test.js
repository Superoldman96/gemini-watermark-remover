import test from 'node:test';
import assert from 'node:assert/strict';

import {
    collectInitialWatermarkCandidates,
    selectInitialWatermarkCandidate
} from '../../src/core/pipelineInitialSelection.js';

function createBaseInput(selectCandidate) {
    return {
        originalImageData: { width: 100, height: 100, data: new Uint8ClampedArray(100 * 100 * 4) },
        config: { logoSize: 48, marginRight: 32, marginBottom: 32 },
        position: { x: 20, y: 20, width: 48, height: 48 },
        alpha48: new Float32Array(48 * 48),
        alpha96: new Float32Array(96 * 96),
        alphaGainCandidates: [1],
        alphaPriorityGains: [1],
        selectCandidate
    };
}

test('selectInitialWatermarkCandidate should keep the first selected standard candidate', () => {
    const calls = [];
    const selectedTrial = { id: 'standard-trial' };
    const result = selectInitialWatermarkCandidate(createBaseInput((args) => {
        calls.push(args);
        return {
            selectedTrial,
            source: 'standard',
            decisionTier: 'direct-match'
        };
    }));

    assert.equal(result.selectedTrial, selectedTrial);
    assert.equal(result.source, 'standard');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].allowAutomaticSearch, false);
});

test('selectInitialWatermarkCandidate should use aggressive located fallback when standard selection skips', () => {
    const calls = [];
    const selectedTrial = {
        id: 'aggressive-trial',
        processedSpatialScore: 0.08,
        nearBlackIncrease: 0.01,
        nearWhiteIncrease: 0.01,
        damage: { safe: true }
    };
    const result = selectInitialWatermarkCandidate(createBaseInput((args) => {
        calls.push(args);
        return calls.length === 1
            ? { selectedTrial: null, source: 'skipped', decisionTier: 'insufficient' }
            : { selectedTrial, source: 'located', decisionTier: null };
    }));

    assert.equal(result.selectedTrial, selectedTrial);
    assert.equal(result.source, 'located+aggressive-located');
    assert.equal(result.decisionTier, 'direct-match');
    assert.equal(calls.length, 2);
    assert.equal(calls[1].allowAutomaticSearch, true);
    assert.equal(calls[1].allowAggressiveStrongLocated, true);
});

test('selectInitialWatermarkCandidate should reject aggressive fallback polarity overshoot', () => {
    const calls = [];
    const skipped = { selectedTrial: null, source: 'skipped', decisionTier: 'insufficient' };
    const result = selectInitialWatermarkCandidate(createBaseInput(() => {
        calls.push(true);
        return calls.length === 1 ? skipped : {
            selectedTrial: {
                processedSpatialScore: -0.9,
                nearBlackIncrease: 0,
                nearWhiteIncrease: 0.2,
                damage: { safe: true }
            },
            source: 'located',
            decisionTier: 'validated-match'
        };
    }));

    assert.equal(result.selectedTrial, null);
    assert.equal(result.source, 'skipped');
    assert.equal(calls.length, 2);
});

test('selectInitialWatermarkCandidate should respect disabled aggressive fallback', () => {
    const calls = [];
    const result = selectInitialWatermarkCandidate({
        ...createBaseInput((args) => {
            calls.push(args);
            return { selectedTrial: null, source: 'skipped', decisionTier: 'insufficient' };
        }),
        aggressiveLocatedFallback: false
    });

    assert.equal(result.selectedTrial, null);
    assert.equal(result.source, 'skipped');
    assert.equal(calls.length, 1);
});

test('collectInitialWatermarkCandidates should retain fixed and unsafe aggressive hypotheses', () => {
    const calls = [];
    const createTrial = (source, x, overrides = {}) => ({
        source,
        config: { logoSize: 48, marginRight: 32, marginBottom: 32 },
        position: { x, y: 20, width: 48, height: 48 },
        alphaMap: new Float32Array(48 * 48).fill(0.2),
        alphaGain: 1,
        rankingKey: [x, 0, 0, 0, 0, 0],
        provenance: {},
        ...overrides
    });
    const standard = createTrial('standard', 20);
    const outline = createTrial('standard+outline-dark', 30, {
        provenance: { outlineDark: true }
    });
    const adaptive = createTrial('adaptive', 40, {
        provenance: { adaptive: true }
    });
    const aggressive = createTrial('adaptive+aggressive-located', 50, {
        processedSpatialScore: -0.9,
        nearWhiteIncrease: 0.2,
        damage: { safe: false }
    });

    const result = collectInitialWatermarkCandidates(createBaseInput((args) => {
        calls.push(args);
        return args.allowAutomaticSearch
            ? {
                selectedTrial: aggressive,
                candidatePool: [adaptive, aggressive],
                source: aggressive.source
            }
            : {
                selectedTrial: standard,
                candidatePool: [standard, outline],
                source: standard.source
            };
    }));

    assert.equal(calls.length, 2);
    assert.equal(calls[0].allowAutomaticSearch, false);
    assert.equal(calls[1].allowAutomaticSearch, true);
    assert.equal(calls[1].allowAggressiveStrongLocated, true);
    assert.deepEqual(result.hypotheses.map((item) => item.family).sort(), [
        'aggressive',
        'alpha',
        'geometry',
        'polarity',
        'standard'
    ]);
    assert.ok(result.hypotheses.some((item) => item.trial === aggressive));
    assert.ok(result.hypotheses.some((item) => item.trial === standard));
    assert.ok(result.hypotheses.some((item) => (
        item.family === 'alpha' &&
        item.alphaGain <= 0.5 &&
        item.trial.provenance?.topNConservative === true
    )));
});

test('collectInitialWatermarkCandidates should retain conservative alpha trials for fixed and automatic anchors', () => {
    const alphaMap = new Float32Array(48 * 48).fill(0.2);
    const createTrial = (source, x, provenance = {}) => ({
        source,
        config: { logoSize: 48, marginRight: 32, marginBottom: 32 },
        position: { x, y: 20, width: 48, height: 48 },
        alphaMap,
        alphaGain: 1,
        rankingKey: [x, 0, 0, 0, 0, 0],
        provenance
    });
    const fixed = createTrial('standard', 20);
    const automatic = createTrial('adaptive', 40, { adaptive: true });

    const result = collectInitialWatermarkCandidates(createBaseInput((args) => (
        args.allowAutomaticSearch
            ? { selectedTrial: automatic, candidatePool: [automatic] }
            : { selectedTrial: fixed, candidatePool: [fixed] }
    )));

    const conservative = result.hypotheses.filter((item) => (
        item.family === 'alpha' &&
        item.alphaGain <= 0.5 &&
        item.trial.provenance?.topNConservative === true
    ));
    assert.deepEqual(conservative
        .map((item) => ({ x: item.position.x, alphaGain: item.alphaGain }))
        .sort((left, right) => left.x - right.x), [
        { x: 20, alphaGain: 0.5 },
        { x: 40, alphaGain: 0.25 }
    ]);
});

test('collectInitialWatermarkCandidates should relax all alternatives when automatic selection falls back to aggressive', () => {
    const alphaMap = new Float32Array(48 * 48).fill(0.2);
    const standardAlternative = {
        source: 'standard+catalog',
        config: { logoSize: 48, marginRight: 96, marginBottom: 96 },
        position: { x: 4, y: 20, width: 48, height: 48 },
        alphaMap,
        alphaGain: 1,
        rankingKey: [0, 0, 0, 0, 0, 0],
        provenance: {}
    };
    const aggressive = {
        source: 'adaptive+aggressive-located',
        config: { logoSize: 48, marginRight: 16, marginBottom: 48 },
        position: { x: 36, y: 20, width: 48, height: 48 },
        alphaMap,
        alphaGain: 1,
        rankingKey: [1, 0, 0, 0, 0, 0],
        provenance: { adaptive: true }
    };
    const polarityAlternative = {
        source: 'standard+outline-dark',
        config: { logoSize: 48, marginRight: 96, marginBottom: 96 },
        position: { x: 12, y: 20, width: 48, height: 48 },
        alphaMap,
        alphaGain: 1,
        rankingKey: [0, 1, 0, 0, 0, 0],
        provenance: { outlineDark: true }
    };

    const result = collectInitialWatermarkCandidates(createBaseInput((args) => (
        args.allowAutomaticSearch
            ? {
                selectedTrial: aggressive,
                candidatePool: [standardAlternative, polarityAlternative, aggressive]
            }
            : {
                selectedTrial: null,
                candidatePool: [standardAlternative, polarityAlternative]
            }
    )));

    const retainedStandard = result.hypotheses.find((item) => item.trial === standardAlternative);
    const retainedPolarity = result.hypotheses.find((item) => item.trial === polarityAlternative);
    assert.equal(retainedStandard?.family, 'standard');
    assert.equal(retainedPolarity?.family, 'polarity');
    assert.equal(retainedStandard?.discoveryRole, 'aggressive-fallback-alternative');
    assert.equal(retainedPolarity?.discoveryRole, 'aggressive-fallback-alternative');
});

test('collectInitialWatermarkCandidates should not introduce automatic geometry when adaptive search is disabled', () => {
    const calls = [];
    const fixed = {
        source: 'standard',
        config: { logoSize: 48, marginRight: 32, marginBottom: 32 },
        position: { x: 20, y: 20, width: 48, height: 48 },
        alphaMap: new Float32Array(48 * 48).fill(0.2),
        alphaGain: 1,
        rankingKey: [0, 0, 0, 0, 0, 0],
        provenance: {}
    };

    const result = collectInitialWatermarkCandidates({
        ...createBaseInput((args) => {
            calls.push(args);
            return { selectedTrial: fixed, candidatePool: [fixed] };
        }),
        allowAdaptiveSearch: false
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].allowAutomaticSearch, false);
    assert.equal(result.hypotheses.some((item) => item.family === 'geometry'), false);
    assert.equal(result.hypotheses.some((item) => item.family === 'aggressive'), false);
});
