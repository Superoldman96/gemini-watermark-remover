import {
  bindOriginalAssetUrlToImages,
  installPageImageReplacement
} from '../shared/pageImageReplacement.js';
import {
  extractGeminiImageAssetIds,
  getGeminiImageQuerySelector
} from '../shared/domAdapter.js';
import { installGeminiClipboardImageHook } from './clipboardHook.js';
import {
  createGeminiDownloadIntentGate,
  createGeminiDownloadRpcFetchHook,
  installGeminiDownloadRpcXmlHttpRequestHook,
  installGeminiDownloadHook
} from './downloadHook.js';
import { createUserscriptBlobFetcher } from './crossOriginFetch.js';
import {
  createPageProcessBridgeClient
} from './pageProcessBridge.js';
import {
  requestGeminiConversationHistoryBindings
} from './historyBindingBootstrap.js';
import {
  installUserscriptProcessBridge
} from './processBridge.js';
import { installInjectedPageProcessorRuntime } from './pageProcessorRuntime.js';
import { createUserscriptProcessingRuntime } from './processingRuntime.js';
import {
  isGeminiOriginalAssetUrl,
  normalizeGoogleusercontentImageUrl
} from './urlUtils.js';

const USERSCRIPT_WORKER_CODE = typeof __US_WORKER_CODE__ === 'string' ? __US_WORKER_CODE__ : '';
const USERSCRIPT_PAGE_PROCESSOR_CODE =
  typeof __US_PAGE_PROCESSOR_CODE__ === 'string' ? __US_PAGE_PROCESSOR_CODE__ : '';

function shouldSkipFrame(targetWindow) {
  if (!targetWindow) {
    return false;
  }
  try {
    return targetWindow.top && targetWindow.top !== targetWindow.self;
  } catch {
    return false;
  }
}

function assetIdsMatch(candidate = null, target = null) {
  if (!candidate || !target) {
    return false;
  }

  if (candidate.draftId && target.draftId) {
    return candidate.draftId === target.draftId;
  }

  return Boolean(
    candidate.responseId
      && target.responseId
      && candidate.responseId === target.responseId
      && candidate.conversationId
      && target.conversationId
      && candidate.conversationId === target.conversationId
  );
}

function findGeminiImageElementForAssetIds(root, assetIds) {
  if (!root || !assetIds || typeof root.querySelectorAll !== 'function') {
    return null;
  }

  let fallbackMatch = null;
  for (const imageElement of root.querySelectorAll(getGeminiImageQuerySelector())) {
    if (!assetIdsMatch(extractGeminiImageAssetIds(imageElement), assetIds)) {
      continue;
    }

    if (imageElement?.dataset?.gwrWatermarkObjectUrl) {
      return imageElement;
    }

    fallbackMatch ||= imageElement;
  }

  return fallbackMatch;
}

function collectCandidateImagesFromRoot(root) {
  if (!root || typeof root !== 'object') {
    return [];
  }

  const candidates = [];
  if (typeof root.tagName === 'string' && root.tagName.toUpperCase() === 'IMG') {
    candidates.push(root);
  }
  if (typeof root.querySelectorAll === 'function') {
    candidates.push(...root.querySelectorAll('img'));
  }
  return candidates.filter(Boolean);
}

function findPreferredGeminiImageElement(root, assetIds) {
  const candidates = collectCandidateImagesFromRoot(root);
  if (candidates.length === 0) {
    return null;
  }

  const matchingAssetCandidate = assetIds
    ? candidates.find((imageElement) => assetIdsMatch(extractGeminiImageAssetIds(imageElement), assetIds))
    : null;
  const processedMatchingAssetCandidate = matchingAssetCandidate?.dataset?.gwrWatermarkObjectUrl
    ? matchingAssetCandidate
    : null;
  if (processedMatchingAssetCandidate) {
    return processedMatchingAssetCandidate;
  }
  if (matchingAssetCandidate) {
    return matchingAssetCandidate;
  }

  const processedProcessableCandidate = candidates.find((imageElement) => (
    typeof imageElement?.dataset?.gwrWatermarkObjectUrl === 'string'
      && imageElement.dataset.gwrWatermarkObjectUrl.trim()
  ));
  if (processedProcessableCandidate) {
    return processedProcessableCandidate;
  }

  return candidates[0] || null;
}

function findNearbyGeminiImageElement(targetWindow, target, assetIds) {
  const buttonLike = typeof target?.closest === 'function'
    ? target.closest('button,[role="button"]')
    : null;
  const globalAssetMatch = assetIds
    ? findGeminiImageElementForAssetIds(targetWindow?.document || document, assetIds)
    : null;
  const candidateRoots = [
    buttonLike?.closest?.('generated-image,.generated-image-container'),
    buttonLike?.closest?.('single-image'),
    buttonLike?.closest?.('expansion-dialog,[role="dialog"],.image-expansion-dialog-panel,.cdk-overlay-pane'),
    buttonLike?.closest?.('[data-test-draft-id]')
  ].filter(Boolean);

  for (const root of candidateRoots) {
    const imageElement = findPreferredGeminiImageElement(root, assetIds);
    if (imageElement?.dataset?.gwrWatermarkObjectUrl) {
      return imageElement;
    }
    if (globalAssetMatch?.dataset?.gwrWatermarkObjectUrl) {
      return globalAssetMatch;
    }
    if (imageElement) {
      return imageElement;
    }
  }

  return globalAssetMatch;
}

(async function init() {
  try {
    const targetWindow = typeof unsafeWindow === 'object' && unsafeWindow
      ? unsafeWindow
      : window;
    if (shouldSkipFrame(targetWindow)) {
      return;
    }

    console.log('[Gemini Watermark Remover] Initializing...');
    const originalPageFetch = typeof unsafeWindow?.fetch === 'function'
      ? unsafeWindow.fetch.bind(unsafeWindow)
      : null;
    const userscriptRequest = typeof GM_xmlhttpRequest === 'function'
      ? GM_xmlhttpRequest
      : globalThis.GM_xmlhttpRequest;
    const previewBlobFetcher = createUserscriptBlobFetcher({
      gmRequest: userscriptRequest,
      fallbackFetch: originalPageFetch
    });

    const processingRuntime = createUserscriptProcessingRuntime({
      workerCode: USERSCRIPT_WORKER_CODE,
      env: globalThis,
      logger: console
    });
    let pageProcessClient = null;
    const removeWatermarkFromBestAvailablePath = (blob, options = {}) => (
      pageProcessClient?.removeWatermarkFromBlob
        ? pageProcessClient.removeWatermarkFromBlob(blob, options)
        : processingRuntime.removeWatermarkFromBlob(blob, options)
    );

    const handleOriginalAssetDiscovered = ({ normalizedUrl, discoveredUrl, intentMetadata }) => {
      const sourceUrl = normalizedUrl || discoveredUrl || '';
      const assetIds = intentMetadata?.assetIds;
      if (!assetIds || !sourceUrl) return;
      bindOriginalAssetUrlToImages({
        root: targetWindow.document || document,
        assetIds,
        sourceUrl
      });
    };
    const downloadIntentGate = createGeminiDownloadIntentGate({
      targetWindow,
      resolveMetadata: (target) => {
        const imageElement = findNearbyGeminiImageElement(targetWindow, target, null);
        const assetIds = extractGeminiImageAssetIds(target)
          || extractGeminiImageAssetIds(imageElement);
        return {
          target,
          assetIds,
          imageElement: imageElement || findNearbyGeminiImageElement(targetWindow, target, assetIds)
        };
      }
    });
    const downloadRpcFetch = createGeminiDownloadRpcFetchHook({
      originalFetch: targetWindow.fetch.bind(targetWindow),
      getIntentMetadata: () => downloadIntentGate.getRecentIntentMetadata(),
      onOriginalAssetDiscovered: ({ rpcUrl, discoveredUrl, intentMetadata }) => {
        handleOriginalAssetDiscovered({
          rpcUrl,
          discoveredUrl,
          normalizedUrl: discoveredUrl,
          intentMetadata
        });
      },
      logger: console
    });
    installGeminiDownloadRpcXmlHttpRequestHook(targetWindow, {
      getIntentMetadata: () => downloadIntentGate.getRecentIntentMetadata(),
      onOriginalAssetDiscovered: ({ rpcUrl, discoveredUrl, intentMetadata }) => {
        handleOriginalAssetDiscovered({
          rpcUrl,
          discoveredUrl,
          normalizedUrl: discoveredUrl,
          intentMetadata
        });
      },
      logger: console
    });
    installGeminiDownloadHook(targetWindow, {
      originalFetch: downloadRpcFetch,
      intentGate: downloadIntentGate,
      isTargetUrl: isGeminiOriginalAssetUrl,
      normalizeUrl: normalizeGoogleusercontentImageUrl,
      processBlob: removeWatermarkFromBestAvailablePath,
      onOriginalAssetDiscovered: ({ normalizedUrl, intentMetadata }) => {
        handleOriginalAssetDiscovered({
          normalizedUrl,
          intentMetadata
        });
      },
      logger: console
    });
    const disposeClipboardHook = installGeminiClipboardImageHook(targetWindow, {
      getIntentMetadata: () => downloadIntentGate.getRecentIntentMetadata(),
      resolveImageElement: (intentMetadata) => findNearbyGeminiImageElement(
        targetWindow,
        intentMetadata?.target || null,
        intentMetadata?.assetIds || null
      ),
      logger: console
    });
    await requestGeminiConversationHistoryBindings({
      targetWindow,
      fetchImpl: targetWindow.fetch.bind(targetWindow),
      logger: console
    });
    await processingRuntime.initialize();
    await installInjectedPageProcessorRuntime({
      targetWindow,
      scriptCode: USERSCRIPT_PAGE_PROCESSOR_CODE,
      logger: console
    });
    pageProcessClient = createPageProcessBridgeClient({
      targetWindow,
      logger: console,
      fallbackProcessWatermarkBlob: processingRuntime.processWatermarkBlob,
      fallbackRemoveWatermarkFromBlob: processingRuntime.removeWatermarkFromBlob
    });

    installUserscriptProcessBridge({
      targetWindow,
      processWatermarkBlob: processingRuntime.processWatermarkBlob,
      removeWatermarkFromBlob: processingRuntime.removeWatermarkFromBlob,
      logger: console
    });

    const pageImageReplacementController = installPageImageReplacement({
      logger: console,
      fetchPreviewBlob: previewBlobFetcher,
      processWatermarkBlobImpl: pageProcessClient.processWatermarkBlob,
      removeWatermarkFromBlobImpl: pageProcessClient.removeWatermarkFromBlob
    });

    window.addEventListener('beforeunload', () => {
      pageImageReplacementController?.dispose?.();
      disposeClipboardHook();
      downloadIntentGate.dispose();
      processingRuntime.dispose('beforeunload');
    });

    console.log('[Gemini Watermark Remover] Ready');
  } catch (error) {
    console.error('[Gemini Watermark Remover] Initialization failed:', error);
  }
})();
