import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createCachedImageProcessor,
  createSharedBlobProcessor,
  loadImageFromBlob
} from '../../src/shared/imageProcessing.js';

test('loadImageFromBlob should fall back to createImageBitmap when Image decode fails', async () => {
  const originalImage = globalThis.Image;
  const originalCreateObjectURL = globalThis.URL.createObjectURL;
  const originalRevokeObjectURL = globalThis.URL.revokeObjectURL;
  const originalCreateImageBitmap = globalThis.createImageBitmap;

  const revoked = [];

  globalThis.URL.createObjectURL = () => 'blob:test';
  globalThis.URL.revokeObjectURL = (url) => revoked.push(url);
  globalThis.Image = class MockImage {
    set src(_value) {
      queueMicrotask(() => {
        this.onerror?.(new Error('decode failed'));
      });
    }
  };
  globalThis.createImageBitmap = async (blob) => ({
    width: 64,
    height: 64,
    blob
  });

  try {
    const blob = new Blob(['fixture'], { type: 'image/png' });
    const result = await loadImageFromBlob(blob);

    assert.equal(result.width, 64);
    assert.equal(result.height, 64);
    assert.equal(result.blob, blob);
    assert.deepEqual(revoked, ['blob:test']);
  } finally {
    globalThis.Image = originalImage;
    globalThis.URL.createObjectURL = originalCreateObjectURL;
    globalThis.URL.revokeObjectURL = originalRevokeObjectURL;
    globalThis.createImageBitmap = originalCreateImageBitmap;
  }
});

test('createSharedBlobProcessor should use main-thread path in stable shared mode', async () => {
  const inputBlob = new Blob(['fixture'], { type: 'image/png' });
  let mainThreadCalls = 0;

  const processBlob = createSharedBlobProcessor({
    processMainThread: async (blob, options) => {
      mainThreadCalls += 1;
      assert.equal(blob, inputBlob);
      assert.deepEqual(options, { adaptiveMode: 'always' });
      return {
        processedBlob: new Blob(['main-thread'], { type: 'image/png' }),
        processedMeta: { source: 'main-thread' }
      };
    }
  });

  const result = await processBlob(inputBlob);

  assert.equal(mainThreadCalls, 1);
  assert.equal(result.processedBlob.type, 'image/png');
  assert.equal(result.processedMeta?.source, 'main-thread');
  assert.equal(result.processedMeta?.processorPath, 'main-thread');
});

test('createCachedImageProcessor should cache engine creation across calls', async () => {
  const renderable = { width: 32, height: 32 };
  const canvas = {
    __watermarkMeta: {
      source: 'engine'
    }
  };
  let createEngineCalls = 0;
  const removeCalls = [];

  const processRenderable = createCachedImageProcessor({
    createEngine: async () => {
      createEngineCalls += 1;
      return {
        async removeWatermarkFromImage(image, options) {
          removeCalls.push({ image, options });
          return canvas;
        }
      };
    },
    encodeCanvas: async (inputCanvas) => {
      assert.equal(inputCanvas, canvas);
      return new Blob(['encoded'], { type: 'image/png' });
    }
  });

  await processRenderable(renderable, { adaptiveMode: 'never' });
  await processRenderable(renderable, { maxPasses: 2 });

  assert.equal(createEngineCalls, 1);
  assert.deepEqual(removeCalls, [
    {
      image: renderable,
      options: { adaptiveMode: 'never' }
    },
    {
      image: renderable,
      options: { adaptiveMode: 'always', maxPasses: 2 }
    }
  ]);
});

test('createSharedBlobProcessor should fallback to main-thread when worker path fails', async () => {
  const inputBlob = new Blob(['fixture'], { type: 'image/png' });
  const workerError = new Error('worker failed');
  const workerCalls = [];
  const fallbackErrors = [];

  const processBlob = createSharedBlobProcessor({
    getWorkerProcessor() {
      return async (blob, options) => {
        workerCalls.push({ blob, options });
        throw workerError;
      };
    },
    onWorkerError(error) {
      fallbackErrors.push(error);
    },
    processMainThread: async (blob, options) => {
      assert.equal(blob, inputBlob);
      assert.deepEqual(options, { adaptiveMode: 'always', maxPasses: 1 });
      return {
        processedBlob: new Blob(['main-thread'], { type: 'image/png' }),
        processedMeta: { source: 'main-thread' }
      };
    }
  });

  const result = await processBlob(inputBlob, { maxPasses: 1 });

  assert.deepEqual(workerCalls, [
    {
      blob: inputBlob,
      options: { adaptiveMode: 'always', maxPasses: 1 }
    }
  ]);
  assert.deepEqual(fallbackErrors, [workerError]);
  assert.equal(result.processedMeta?.source, 'main-thread');
  assert.equal(result.processedMeta?.processorPath, 'main-thread');
});
