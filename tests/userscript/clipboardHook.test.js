import test from 'node:test';
import assert from 'node:assert/strict';

import { installGeminiClipboardImageHook } from '../../src/userscript/clipboardHook.js';
import { createImageSessionStore } from '../../src/shared/imageSessionStore.js';
import { loadModuleSource, normalizeWhitespace } from '../testUtils/moduleStructure.js';

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

test('clipboard hook should resolve action context only at the provider boundary', () => {
  const source = normalizeWhitespace(loadModuleSource('../../src/userscript/clipboardHook.js', import.meta.url));

  assert.match(source, /import \{ createActionContextProvider \} from '\.\.\/shared\/actionContextCompat\.js'/);
  assert.match(source, /const resolveActionContextProvider = typeof provideActionContext === 'function' \? provideActionContext : createActionContextProvider\(\{ getActionContext \}\)/);
  assert.match(source, /const actionContext = resolveActionContextProvider\(\)/);
  assert.match(source, /const processedBlob = await resolveProcessedClipboardBlob\(\{ actionContext,/);
  assert.doesNotMatch(source, /getIntentMetadata/);
});

test('installGeminiClipboardImageHook should replace copied Gemini image data with processed blob when actionContext has a processed object url', async () => {
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
    getActionContext: () => ({
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
    getActionContext: () => ({
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
    getActionContext: () => ({
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

test('installGeminiClipboardImageHook should resolve the processed blob from the shared image session when fullscreen intent points at the same Gemini asset', async () => {
  const writtenItems = [];
  const processedBlob = new Blob(['processed-from-session'], { type: 'image/png' });
  const imageSessionStore = createImageSessionStore({
    now: () => 123456
  });
  const sessionKey = imageSessionStore.getOrCreateByAssetIds({
    responseId: 'r_clipboard_session',
    draftId: 'rc_clipboard_session',
    conversationId: 'c_clipboard_session'
  });
  imageSessionStore.updateProcessedResult(sessionKey, {
    objectUrl: 'blob:https://gemini.google.com/session-processed',
    blobType: 'image/png',
    processedFrom: 'page-fetch'
  });

  const clipboard = {
    async write(items) {
      writtenItems.push(items);
    }
  };
  const imageElement = {
    dataset: {
      gwrResponseId: 'r_clipboard_session',
      gwrDraftId: 'rc_clipboard_session',
      gwrConversationId: 'c_clipboard_session'
    }
  };
  const targetWindow = {
    navigator: { clipboard },
    ClipboardItem: MockClipboardItem
  };

  const dispose = installGeminiClipboardImageHook(targetWindow, {
    imageSessionStore,
    getActionContext: () => ({
      assetIds: {
        draftId: 'rc_clipboard_session'
      }
    }),
    resolveImageElement: () => imageElement,
    fetchBlobDirect: async () => {
      throw new Error('session blob urls should be resolved through image decoding when an image element is available');
    },
    resolveBlobViaImageElement: async ({ objectUrl, imageElement: resolvedImageElement }) => {
      assert.equal(objectUrl, 'blob:https://gemini.google.com/session-processed');
      assert.equal(resolvedImageElement, imageElement);
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

test('installGeminiClipboardImageHook should reuse an existing preview processed session blob without decoding object urls', async () => {
  const writtenItems = [];
  const processedBlob = new Blob(['processed-from-session-blob'], { type: 'image/png' });
  const imageSessionStore = createImageSessionStore({
    now: () => 123456
  });
  const sessionKey = imageSessionStore.getOrCreateByAssetIds({
    responseId: 'r_clipboard_blob',
    draftId: 'rc_clipboard_blob',
    conversationId: 'c_clipboard_blob'
  });
  imageSessionStore.updateProcessedResult(sessionKey, {
    slot: 'preview',
    objectUrl: 'blob:https://gemini.google.com/session-preview-blob',
    blob: processedBlob,
    blobType: 'image/png',
    processedFrom: 'preview-candidate'
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
    imageSessionStore,
    getActionContext: () => ({
      action: 'clipboard',
      sessionKey: 'draft:rc_clipboard_blob',
      assetIds: {
        draftId: 'rc_clipboard_blob'
      }
    }),
    fetchBlobDirect: async () => {
      throw new Error('clipboard should reuse the session blob before falling back to fetch');
    },
    resolveBlobViaImageElement: async () => {
      throw new Error('clipboard should reuse the session blob before decoding object urls');
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

test('installGeminiClipboardImageHook should use getActionContext when provided', async () => {
  const writtenItems = [];
  const processedBlob = new Blob(['processed-from-action-context'], { type: 'image/png' });
  const imageSessionStore = createImageSessionStore({
    now: () => 123456
  });
  const sessionKey = imageSessionStore.getOrCreateByAssetIds({
    responseId: 'r_clipboard_action_context',
    draftId: 'rc_clipboard_action_context',
    conversationId: 'c_clipboard_action_context'
  });
  imageSessionStore.updateProcessedResult(sessionKey, {
    slot: 'preview',
    objectUrl: 'blob:https://gemini.google.com/session-preview-action-context',
    blob: processedBlob,
    blobType: 'image/png',
    processedFrom: 'preview-candidate'
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
    imageSessionStore,
    getActionContext: () => ({
      action: 'clipboard',
      sessionKey: 'draft:rc_clipboard_action_context',
      assetIds: {
        draftId: 'rc_clipboard_action_context'
      }
    }),
    fetchBlobDirect: async () => {
      throw new Error('clipboard should reuse the action context session blob before falling back to fetch');
    },
    resolveBlobViaImageElement: async () => {
      throw new Error('clipboard should reuse the action context session blob before decoding object urls');
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

test('installGeminiClipboardImageHook should prefer provideActionContext over getActionContext', async () => {
  const writtenItems = [];
  const processedBlob = new Blob(['processed-from-provided-action-context'], { type: 'image/png' });
  const imageSessionStore = createImageSessionStore({
    now: () => 123456
  });
  const sessionKey = imageSessionStore.getOrCreateByAssetIds({
    responseId: 'r_clipboard_provided_action_context',
    draftId: 'rc_clipboard_provided_action_context',
    conversationId: 'c_clipboard_provided_action_context'
  });
  imageSessionStore.updateProcessedResult(sessionKey, {
    slot: 'preview',
    objectUrl: 'blob:https://gemini.google.com/session-preview-provided-action-context',
    blob: processedBlob,
    blobType: 'image/png',
    processedFrom: 'preview-candidate'
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
    imageSessionStore,
    provideActionContext: () => ({
      action: 'clipboard',
      sessionKey: 'draft:rc_clipboard_provided_action_context',
      assetIds: {
        draftId: 'rc_clipboard_provided_action_context'
      }
    }),
    getActionContext: () => ({
      action: 'clipboard',
      sessionKey: 'draft:rc_wrong_clipboard_action_context',
      assetIds: {
        draftId: 'rc_wrong_clipboard_action_context'
      }
    }),
    fetchBlobDirect: async () => {
      throw new Error('clipboard should reuse the provided action context session blob before falling back to fetch');
    },
    resolveBlobViaImageElement: async () => {
      throw new Error('clipboard should reuse the provided action context session blob before decoding object urls');
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
