import test from 'node:test';
import assert from 'node:assert/strict';

import {
    assessCalibratedWatermarkResidualVisibility,
    assessRemovalDiffArtifacts,
    assessReferenceTextureAlignment,
    assessReferenceTextureAlignmentFromStats,
    assessWatermarkResidualVisibility,
    calculateNearBlackRatio,
    calculateNearWhiteRatio,
    classifyCalibratedResidualMetricRisk,
    cloneImageData
} from '../../src/core/restorationMetrics.js';

test('cloneImageData should return a deep copy for plain image-like objects', () => {
    const original = {
        width: 2,
        height: 1,
        data: new Uint8ClampedArray([10, 20, 30, 255, 40, 50, 60, 255])
    };

    const cloned = cloneImageData(original);
    cloned.data[0] = 99;

    assert.notEqual(cloned.data, original.data);
    assert.equal(original.data[0], 10);
    assert.equal(cloned.width, original.width);
    assert.equal(cloned.height, original.height);
});

test('assessReferenceTextureAlignment should mark a darker flatter candidate as hard reject', () => {
    const width = 96;
    const height = 96;
    const referenceData = new Uint8ClampedArray(width * height * 4);
    const candidateData = new Uint8ClampedArray(width * height * 4);

    for (let i = 0; i < referenceData.length; i += 4) {
        referenceData[i + 3] = 255;
        candidateData[i + 3] = 255;
    }

    const referenceRegion = { x: 24, y: 0, width: 48, height: 48 };
    const position = { x: 24, y: 48, width: 48, height: 48 };

    for (let row = 0; row < 48; row++) {
        for (let col = 0; col < 48; col++) {
            const refIdx = ((referenceRegion.y + row) * width + (referenceRegion.x + col)) * 4;
            const posIdx = ((position.y + row) * width + (position.x + col)) * 4;
            const value = (row + col) % 2 === 0 ? 40 : 180;
            referenceData[refIdx] = value;
            referenceData[refIdx + 1] = value;
            referenceData[refIdx + 2] = value;
            candidateData[posIdx] = 18;
            candidateData[posIdx + 1] = 18;
            candidateData[posIdx + 2] = 18;
        }
    }

    const assessment = assessReferenceTextureAlignment({
        referenceImageData: { width, height, data: referenceData },
        candidateImageData: { width, height, data: candidateData },
        position
    });

    assert.equal(assessment.tooDark, true);
    assert.equal(assessment.tooFlat, true);
    assert.equal(assessment.hardReject, true);
    assert.ok(assessment.texturePenalty > 0, `texturePenalty=${assessment.texturePenalty}`);
});

test('assessReferenceTextureAlignmentFromStats should hard reject visibly darker candidates on flat backgrounds even when texture is preserved', () => {
    const assessment = assessReferenceTextureAlignmentFromStats({
        position: { x: 24, y: 48, width: 48, height: 48 },
        candidateTextureStats: {
            meanLum: 37,
            stdLum: 3.2
        },
        referenceImageData: {
            width: 96,
            height: 96,
            data: (() => {
                const data = new Uint8ClampedArray(96 * 96 * 4);
                for (let i = 0; i < data.length; i += 4) {
                    data[i] = 42;
                    data[i + 1] = 42;
                    data[i + 2] = 42;
                    data[i + 3] = 255;
                }
                return data;
            })()
        }
    });

    assert.equal(assessment.tooDark, true);
    assert.equal(assessment.tooFlat, false);
    assert.equal(assessment.hardReject, true);
});

test('calculateNearBlackRatio should count only near-black pixels inside the target region', () => {
    const imageData = {
        width: 2,
        height: 2,
        data: new Uint8ClampedArray([
            0, 0, 0, 255,
            6, 6, 6, 255,
            4, 4, 4, 255,
            20, 20, 20, 255
        ])
    };

    const ratio = calculateNearBlackRatio(imageData, {
        x: 0,
        y: 0,
        width: 2,
        height: 2
    });

    assert.equal(ratio, 0.5);
});

test('calculateNearWhiteRatio should require every color channel to be near white', () => {
    const imageData = {
        width: 2,
        height: 2,
        data: new Uint8ClampedArray([
            255, 255, 255, 255,
            250, 250, 250, 255,
            255, 249, 255, 255,
            240, 255, 255, 255
        ])
    };

    const ratio = calculateNearWhiteRatio(imageData, {
        x: 0,
        y: 0,
        width: 2,
        height: 2
    });

    assert.equal(ratio, 0.5);
});

test('assessRemovalDiffArtifacts should identify ideal inverse-alpha removal shape', () => {
    const width = 8;
    const height = 8;
    const position = { x: 2, y: 2, width: 4, height: 4 };
    const alphaMap = new Float32Array([
        0, 0.2, 0.2, 0,
        0.2, 0.5, 0.5, 0.2,
        0.2, 0.5, 0.5, 0.2,
        0, 0.2, 0.2, 0
    ]);
    const originalImageData = {
        width,
        height,
        data: new Uint8ClampedArray(width * height * 4)
    };
    const candidateImageData = {
        width,
        height,
        data: new Uint8ClampedArray(width * height * 4)
    };

    for (let index = 0; index < originalImageData.data.length; index += 4) {
        originalImageData.data[index] = 80;
        originalImageData.data[index + 1] = 80;
        originalImageData.data[index + 2] = 80;
        originalImageData.data[index + 3] = 255;
        candidateImageData.data[index] = 80;
        candidateImageData.data[index + 1] = 80;
        candidateImageData.data[index + 2] = 80;
        candidateImageData.data[index + 3] = 255;
    }

    for (let row = 0; row < position.height; row++) {
        for (let col = 0; col < position.width; col++) {
            const alpha = alphaMap[row * position.width + col];
            const pixelIndex = ((position.y + row) * width + position.x + col) * 4;
            const watermarked = Math.round(80 * (1 - alpha) + 255 * alpha);
            originalImageData.data[pixelIndex] = watermarked;
            originalImageData.data[pixelIndex + 1] = watermarked;
            originalImageData.data[pixelIndex + 2] = watermarked;
        }
    }

    const artifacts = assessRemovalDiffArtifacts({
        originalImageData,
        candidateImageData,
        alphaMap,
        position,
        alphaGain: 1
    });

    assert.ok(artifacts.recomposeError < 0.01, `recomposeError=${artifacts.recomposeError}`);
    assert.ok(
        artifacts.diffTemplateCorrelation > 0.95,
        `diffTemplateCorrelation=${artifacts.diffTemplateCorrelation}`
    );
    assert.equal(artifacts.negativeDiffRatio, 0);
});

test('assessWatermarkResidualVisibility should flag bright alpha-band halos even when gradient is low', () => {
    const width = 12;
    const height = 12;
    const position = { x: 4, y: 4, width: 4, height: 4 };
    const alphaMap = new Float32Array([
        0, 0.2, 0.2, 0,
        0.2, 0.3, 0.3, 0.2,
        0.2, 0.3, 0.3, 0.2,
        0, 0.2, 0.2, 0
    ]);
    const imageData = {
        width,
        height,
        data: new Uint8ClampedArray(width * height * 4)
    };

    for (let index = 0; index < imageData.data.length; index += 4) {
        imageData.data[index] = 80;
        imageData.data[index + 1] = 80;
        imageData.data[index + 2] = 80;
        imageData.data[index + 3] = 255;
    }

    for (let row = 0; row < position.height; row++) {
        for (let col = 0; col < position.width; col++) {
            const alpha = alphaMap[row * position.width + col];
            if (alpha < 0.18) continue;
            const pixelIndex = ((position.y + row) * width + position.x + col) * 4;
            imageData.data[pixelIndex] = 92;
            imageData.data[pixelIndex + 1] = 92;
            imageData.data[pixelIndex + 2] = 92;
        }
    }

    const visibility = assessWatermarkResidualVisibility({
        imageData,
        position,
        alphaMap
    });

    assert.equal(visibility.visible, true);
    assert.equal(visibility.visiblePositiveHalo, true);
    assert.ok(visibility.positiveHaloLum >= 6, `positiveHaloLum=${visibility.positiveHaloLum}`);
});

test('assessCalibratedWatermarkResidualVisibility should keep bright halos visible', () => {
    const width = 12;
    const height = 12;
    const position = { x: 4, y: 4, width: 4, height: 4 };
    const alphaMap = new Float32Array([
        0, 0.2, 0.2, 0,
        0.2, 0.3, 0.3, 0.2,
        0.2, 0.3, 0.3, 0.2,
        0, 0.2, 0.2, 0
    ]);
    const imageData = {
        width,
        height,
        data: new Uint8ClampedArray(width * height * 4)
    };

    for (let index = 0; index < imageData.data.length; index += 4) {
        imageData.data[index] = 80;
        imageData.data[index + 1] = 80;
        imageData.data[index + 2] = 80;
        imageData.data[index + 3] = 255;
    }

    for (let row = 0; row < position.height; row++) {
        for (let col = 0; col < position.width; col++) {
            const alpha = alphaMap[row * position.width + col];
            if (alpha < 0.18) continue;
            const pixelIndex = ((position.y + row) * width + position.x + col) * 4;
            imageData.data[pixelIndex] = 92;
            imageData.data[pixelIndex + 1] = 92;
            imageData.data[pixelIndex + 2] = 92;
        }
    }

    const visibility = assessCalibratedWatermarkResidualVisibility({
        imageData,
        position,
        alphaMap
    });

    assert.equal(visibility.rawVisible, true);
    assert.equal(visibility.visible, true);
    assert.equal(visibility.metricRisk, null);
});

test('assessCalibratedWatermarkResidualVisibility should mark flat clipped anti-template as metric risk', () => {
    const width = 12;
    const height = 12;
    const position = { x: 4, y: 4, width: 4, height: 4 };
    const alphaMap = new Float32Array([
        0.02, 0.16, 0.16, 0.02,
        0.16, 0.34, 0.34, 0.16,
        0.16, 0.34, 0.34, 0.16,
        0.02, 0.16, 0.16, 0.02
    ]);
    const originalImageData = {
        width,
        height,
        data: new Uint8ClampedArray(width * height * 4)
    };
    const imageData = cloneImageData(originalImageData);

    for (let index = 0; index < imageData.data.length; index += 4) {
        originalImageData.data[index] = 24;
        originalImageData.data[index + 1] = 24;
        originalImageData.data[index + 2] = 24;
        originalImageData.data[index + 3] = 255;
        imageData.data[index] = 0;
        imageData.data[index + 1] = 0;
        imageData.data[index + 2] = 0;
        imageData.data[index + 3] = 255;
    }

    for (let row = 0; row < position.height; row++) {
        for (let col = 0; col < position.width; col++) {
            const alpha = alphaMap[row * position.width + col];
            const pixelIndex = ((position.y + row) * width + position.x + col) * 4;
            const value = Math.round(5 * (1 - alpha / 0.34));
            imageData.data[pixelIndex] = value;
            imageData.data[pixelIndex + 1] = value;
            imageData.data[pixelIndex + 2] = value;
        }
    }

    const visibility = assessCalibratedWatermarkResidualVisibility({
        imageData,
        originalImageData,
        position,
        alphaMap
    });

    assert.equal(visibility.rawVisible, true);
    assert.equal(visibility.visibleSpatialResidual, true);
    assert.equal(visibility.visible, false);
    assert.equal(visibility.calibratedVisible, false);
    assert.equal(visibility.metricRisk, 'flat-clipped-low-texture-spatial-correlation');
});

test('classifyCalibratedResidualMetricRisk should mark low-gradient positive spatial background collision', () => {
    const metricRisk = classifyCalibratedResidualMetricRisk({
        visibility: {
            visible: true,
            visibleSpatialResidual: true,
            visiblePositiveHalo: false,
            visibleGradientResidual: false,
            positiveHaloLum: 0
        },
        spatialScore: 0.176,
        gradientScore: 0.006,
        nearBlackRatio: 0,
        newlyClippedRatio: 0.001,
        visualArtifactCost: 0.051
    });

    assert.equal(metricRisk, 'positive-spatial-background-collision');
});

test('classifyCalibratedResidualMetricRisk should mark low-gradient positive halo background collision', () => {
    const metricRisk = classifyCalibratedResidualMetricRisk({
        visibility: {
            visible: true,
            visibleSpatialResidual: true,
            visiblePositiveHalo: true,
            visibleGradientResidual: false,
            positiveHaloLum: 29.63
        },
        spatialScore: 0.3,
        gradientScore: -0.018,
        nearBlackRatio: 0,
        newlyClippedRatio: 0,
        visualArtifactCost: 0.075
    });

    assert.equal(metricRisk, 'positive-halo-background-collision');
});

test('classifyCalibratedResidualMetricRisk should mark weak halo-only background collision', () => {
    const metricRisk = classifyCalibratedResidualMetricRisk({
        visibility: {
            visible: true,
            visibleSpatialResidual: false,
            visiblePositiveHalo: true,
            visibleGradientResidual: false,
            positiveHaloLum: 13.1
        },
        spatialScore: 0.04,
        gradientScore: 0.073,
        nearBlackRatio: 0,
        newlyClippedRatio: 0,
        visualArtifactCost: 0.083
    });

    assert.equal(metricRisk, 'weak-halo-background-collision');
});

test('classifyCalibratedResidualMetricRisk should mark structured edge background collision', () => {
    const metricRisk = classifyCalibratedResidualMetricRisk({
        visibility: {
            visible: true,
            visibleSpatialResidual: false,
            visiblePositiveHalo: true,
            visibleGradientResidual: false,
            positiveHaloLum: 21.57
        },
        spatialScore: 0.152,
        gradientScore: 0.21,
        nearBlackRatio: 0,
        newlyClippedRatio: 0,
        visualArtifactCost: 0.248
    });

    assert.equal(metricRisk, 'structured-edge-background-collision');
});
