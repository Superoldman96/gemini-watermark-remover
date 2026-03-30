import test from 'node:test';
import assert from 'node:assert/strict';

import { installGeminiClipboardImageHook } from '../../src/userscript/clipboardHook.js';

class MockClipboardItem {
  constructor(items = {}) {
    this.items = { ...items };
    this.types = Object.keys(this.items);
  }

  async getType(type) {
    const value = this.items[type];
    if (value && typeof value.then === 'function') {
      return value;
    }
    return value;
  }
}

test('installGeminiClipboardImageHook should replace copied Gemini image data with processed blob when intent metadata has a processed object url', async () => {
  const writtenItems = [];
  const originalBlob = new Blob(['original'], { type: 'image/jpeg' });
  const processedBlob = new Blob(['processed'], { type: 'image/png' });
  const clipboard = {
    async write(items) {
      writtenItems.push(items);
    }
  };
  const targetWindow = {
    navigator: { clipboard },
    ClipboardItem: MockClipboardItem
  };

  const dispose = installGeminiClipboardImageHook(targetWindow, {
    getIntentMetadata: () => ({
      imageElement: {
        dataset: {
          gwrWatermarkObjectUrl: 'blob:https://gemini.google.com/processed'
        }
      }
    }),
    fetchBlobDirect: async (url) => {
      assert.equal(url, 'blob:https://gemini.google.com/processed');
      return processedBlob;
    }
  });

  await clipboard.write([
    new MockClipboardItem({
      'image/jpeg': originalBlob,
      'text/plain': Promise.resolve(new Blob(['caption'], { type: 'text/plain' }))
    })
  ]);

  assert.equal(writtenItems.length, 1);
  assert.equal(writtenItems[0].length, 1);
  assert.deepEqual(writtenItems[0][0].types, ['text/plain', 'image/png']);
  assert.equal(await writtenItems[0][0].getType('image/png'), processedBlob);
  assert.equal(
    await (await writtenItems[0][0].getType('text/plain')).text(),
    'caption'
  );

  dispose();
});

test('installGeminiClipboardImageHook should fall back to the original clipboard items when no processed Gemini image is available', async () => {
  const writtenItems = [];
  const originalItem = new MockClipboardItem({
    'image/jpeg': new Blob(['original'], { type: 'image/jpeg' })
  });
  const clipboard = {
    async write(items) {
      writtenItems.push(items);
    }
  };
  const targetWindow = {
    navigator: { clipboard },
    ClipboardItem: MockClipboardItem
  };

  const dispose = installGeminiClipboardImageHook(targetWindow, {
    getIntentMetadata: () => ({
      imageElement: {
        dataset: {}
      }
    }),
    fetchBlobDirect: async () => {
      throw new Error('should not fetch without a processed object url');
    }
  });

  await clipboard.write([originalItem]);

  assert.equal(writtenItems.length, 1);
  assert.equal(writtenItems[0][0], originalItem);

  dispose();
});

test('installGeminiClipboardImageHook should resolve blob object urls through image decoding instead of fetch', async () => {
  const writtenItems = [];
  const processedBlob = new Blob(['processed-from-image'], { type: 'image/png' });
  const clipboard = {
    async write(items) {
      writtenItems.push(items);
    }
  };
  const targetWindow = {
    navigator: { clipboard },
    ClipboardItem: MockClipboardItem
  };

  const dispose = installGeminiClipboardImageHook(targetWindow, {
    getIntentMetadata: () => ({
      imageElement: {
        dataset: {
          gwrWatermarkObjectUrl: 'blob:https://gemini.google.com/processed'
        }
      }
    }),
    fetchBlobDirect: async () => {
      throw new Error('blob object urls should not be fetched through Fetch API');
    },
    resolveBlobViaImageElement: async ({ objectUrl, imageElement }) => {
      assert.equal(objectUrl, 'blob:https://gemini.google.com/processed');
      assert.equal(
        imageElement?.dataset?.gwrWatermarkObjectUrl,
        'blob:https://gemini.google.com/processed'
      );
      return processedBlob;
    }
  });

  await clipboard.write([
    new MockClipboardItem({
      'image/jpeg': new Blob(['original'], { type: 'image/jpeg' })
    })
  ]);

  assert.equal(writtenItems.length, 1);
  assert.deepEqual(writtenItems[0][0].types, ['image/png']);
  assert.equal(await writtenItems[0][0].getType('image/png'), processedBlob);

  dispose();
});
