import test from 'node:test';
import assert from 'node:assert/strict';

import {
    resolveExportAllenkFdncnnPadding,
    VIDEO_DENOISE_BACKENDS
} from '../../src/video/videoExport.js';

test('resolveExportAllenkFdncnnPadding should keep explicit Allenk padding', () => {
    const padding = resolveExportAllenkFdncnnPadding({
        denoiseBackend: VIDEO_DENOISE_BACKENDS.ALLENK_FDNCNN_BROWSER_SPIKE,
        allenkFdncnnPadding: 7
    }, {
        position: { width: 48, height: 48 }
    });

    assert.equal(padding, 7);
});

test('resolveExportAllenkFdncnnPadding should derive missing Allenk padding from detection size', () => {
    const compactPadding = resolveExportAllenkFdncnnPadding({
        denoiseBackend: VIDEO_DENOISE_BACKENDS.ALLENK_FDNCNN_BROWSER_SPIKE
    }, {
        position: { width: 48, height: 48 }
    });
    const standardPadding = resolveExportAllenkFdncnnPadding({
        denoiseBackend: VIDEO_DENOISE_BACKENDS.ALLENK_FDNCNN_BROWSER_SPIKE
    }, {
        position: { width: 72, height: 72 }
    });

    assert.equal(compactPadding, 28);
    assert.equal(standardPadding, 64);
});

test('resolveExportAllenkFdncnnPadding should leave non-Allenk cleanup without padding', () => {
    const padding = resolveExportAllenkFdncnnPadding({
        denoiseBackend: VIDEO_DENOISE_BACKENDS.CANVAS_EDGE_DENOISE
    }, {
        position: { width: 48, height: 48 }
    });

    assert.equal(padding, undefined);
});
