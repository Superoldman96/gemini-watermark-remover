import test from 'node:test';
import assert from 'node:assert/strict';

import { createImageSessionStore } from '../../src/shared/imageSessionStore.js';
import {
  createGeminiActionContextResolver,
  findNearbyGeminiImageElement
} from '../../src/userscript/actionContext.js';

function createImageElement(dataset = {}) {
  return {
    tagName: 'IMG',
    dataset: { ...dataset },
    closest: () => null
  };
}

test('findNearbyGeminiImageElement should prefer the processed global asset match when fullscreen root image is still unprocessed', () => {
  const previewImage = createImageElement({
    gwrResponseId: 'r_action_example',
    gwrDraftId: 'rc_action_example',
    gwrConversationId: 'c_action_example',
    gwrWatermarkObjectUrl: 'blob:https://gemini.google.com/processed-preview'
  });
  const fullscreenImage = createImageElement({
    gwrResponseId: 'r_action_example',
    gwrDraftId: 'rc_action_example',
    gwrConversationId: 'c_action_example'
  });

  const documentImages = [previewImage, fullscreenImage];
  const dialogRoot = {
    querySelectorAll(selector) {
      return selector === 'img' ? [fullscreenImage] : [];
    }
  };
  const buttonLike = {
    closest(selector) {
      return selector === 'expansion-dialog,[role="dialog"],.image-expansion-dialog-panel,.cdk-overlay-pane'
        ? dialogRoot
        : null;
    }
  };
  const target = {
    closest(selector) {
      return selector === 'button,[role="button"]' ? buttonLike : null;
    }
  };
  const targetWindow = {
    document: {
      querySelectorAll() {
        return documentImages;
      }
    }
  };

  const resolved = findNearbyGeminiImageElement(targetWindow, target, {
    responseId: 'r_action_example',
    draftId: 'rc_action_example',
    conversationId: 'c_action_example'
  });

  assert.equal(resolved, previewImage);
});

test('createGeminiActionContextResolver should resolve a target into the shared Gemini image session context', () => {
  const imageSessionStore = createImageSessionStore({
    now: () => 123456
  });
  const sessionKey = imageSessionStore.getOrCreateByAssetIds({
    responseId: 'r_action_context',
    draftId: 'rc_action_context',
    conversationId: 'c_action_context'
  });
  imageSessionStore.updateProcessedResult(sessionKey, {
    objectUrl: 'blob:https://gemini.google.com/action-context-processed',
    blobType: 'image/png',
    processedFrom: 'page-fetch'
  });

  const previewImage = createImageElement({
    gwrResponseId: 'r_action_context',
    gwrDraftId: 'rc_action_context',
    gwrConversationId: 'c_action_context',
    gwrWatermarkObjectUrl: 'blob:https://gemini.google.com/action-context-processed'
  });
  const fullscreenImage = createImageElement({
    gwrResponseId: 'r_action_context',
    gwrDraftId: 'rc_action_context',
    gwrConversationId: 'c_action_context'
  });

  const documentImages = [previewImage, fullscreenImage];
  const dialogRoot = {
    querySelectorAll(selector) {
      return selector === 'img' ? [fullscreenImage] : [];
    }
  };
  const buttonLike = {
    closest(selector) {
      return selector === 'expansion-dialog,[role="dialog"],.image-expansion-dialog-panel,.cdk-overlay-pane'
        ? dialogRoot
        : null;
    }
  };
  const target = {
    closest(selector) {
      return selector === 'button,[role="button"]' ? buttonLike : null;
    }
  };
  const targetWindow = {
    document: {
      querySelectorAll() {
        return documentImages;
      }
    }
  };

  const resolver = createGeminiActionContextResolver({
    targetWindow,
    imageSessionStore
  });

  const context = resolver.resolveActionContext(target);

  assert.equal(context.sessionKey, 'draft:rc_action_context');
  assert.equal(context.imageElement, previewImage);
  assert.deepEqual(context.assetIds, {
    responseId: 'r_action_context',
    draftId: 'rc_action_context',
    conversationId: 'c_action_context'
  });
  assert.deepEqual(context.resource, {
    kind: 'processed',
    url: 'blob:https://gemini.google.com/action-context-processed',
    mimeType: 'image/png',
    processedMeta: null,
    source: 'page-fetch',
    slot: 'preview'
  });
});

test('createGeminiActionContextResolver should prefer the store-attached processed preview element even when nearby DOM lookup misses it', () => {
  const imageSessionStore = createImageSessionStore({
    now: () => 123456
  });
  const sessionKey = imageSessionStore.getOrCreateByAssetIds({
    responseId: 'r_store_preferred_element',
    draftId: 'rc_store_preferred_element',
    conversationId: 'c_store_preferred_element'
  });
  imageSessionStore.updateProcessedResult(sessionKey, {
    objectUrl: 'blob:https://gemini.google.com/store-preferred-processed',
    blobType: 'image/png',
    processedFrom: 'page-fetch'
  });

  const previewImage = createImageElement({
    gwrResponseId: 'r_store_preferred_element',
    gwrDraftId: 'rc_store_preferred_element',
    gwrConversationId: 'c_store_preferred_element',
    gwrWatermarkObjectUrl: 'blob:https://gemini.google.com/store-preferred-processed'
  });
  imageSessionStore.attachElement(sessionKey, 'preview', previewImage);

  const fullscreenImage = createImageElement({
    gwrResponseId: 'r_store_preferred_element',
    gwrDraftId: 'rc_store_preferred_element',
    gwrConversationId: 'c_store_preferred_element'
  });
  const dialogRoot = {
    querySelectorAll(selector) {
      return selector === 'img' ? [fullscreenImage] : [];
    }
  };
  const buttonLike = {
    closest(selector) {
      return selector === 'expansion-dialog,[role="dialog"],.image-expansion-dialog-panel,.cdk-overlay-pane'
        ? dialogRoot
        : null;
    }
  };
  const target = {
    closest(selector) {
      return selector === 'button,[role="button"]' ? buttonLike : null;
    }
  };
  const targetWindow = {
    document: {
      querySelectorAll() {
        return [fullscreenImage];
      }
    }
  };

  const resolver = createGeminiActionContextResolver({
    targetWindow,
    imageSessionStore
  });

  const context = resolver.resolveActionContext(target, {
    action: 'clipboard'
  });

  assert.equal(context.imageElement, previewImage);
  assert.equal(context.sessionKey, 'draft:rc_store_preferred_element');
  assert.equal(context.resource?.slot, 'preview');
});
