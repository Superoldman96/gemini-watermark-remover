import {
  appendCompatibleActionContext,
  resolveCompatibleActionContextFromPayload
} from '../shared/actionContextCompat.js';
import {
  bindOriginalAssetUrlToImages,
  installPageImageReplacement
} from '../shared/pageImageReplacement.js';
import { getDefaultImageSessionStore } from '../shared/imageSessionStore.js';
import { installGeminiClipboardImageHook } from './clipboardHook.js';
import { createGeminiActionContextResolver } from './actionContext.js';
import {
  createGeminiDownloadIntentGate,
  createGeminiDownloadRpcFetchHook,
  extractGeminiAssetBindingsFromResponseText,
  installGeminiDownloadRpcXmlHttpRequestHook,
  installGeminiDownloadHook,
  resolveGeminiActionKind
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
  GWR_ORIGINAL_ASSET_REFRESH_MESSAGE,
  showUserNotice
} from './userNotice.js';
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

function isPreviewReplacementEnabled(targetWindow) {
  try {
    return targetWindow?.localStorage?.getItem('__gwr_enable_preview_replacement__') === '1';
  } catch {
    return false;
  }
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
    const imageSessionStore = getDefaultImageSessionStore();
    const actionContextResolver = createGeminiActionContextResolver({
      targetWindow,
      imageSessionStore
    });
    let pageProcessClient = null;
    const removeWatermarkFromBestAvailablePath = (blob, options = {}) => (
      pageProcessClient?.removeWatermarkFromBlob
        ? pageProcessClient.removeWatermarkFromBlob(blob, options)
        : processingRuntime.removeWatermarkFromBlob(blob, options)
    );

    const handleOriginalAssetDiscovered = (payload = {}) => {
      const sourceUrl = payload.normalizedUrl || payload.discoveredUrl || '';
      const resolvedActionContext = resolveCompatibleActionContextFromPayload(payload);
      const assetIds = resolvedActionContext?.assetIds;
      if (!assetIds || !sourceUrl) return;
      bindOriginalAssetUrlToImages({
        root: targetWindow.document || document,
        assetIds,
        sourceUrl,
        imageSessionStore
      });
    };
    const handleRpcAssetDiscovered = (payload) => {
      handleOriginalAssetDiscovered({
        ...payload,
        normalizedUrl: payload?.discoveredUrl || ''
      });
    };
    const handleActionCriticalFailure = () => {
      showUserNotice(targetWindow, GWR_ORIGINAL_ASSET_REFRESH_MESSAGE);
    };
    const handleProcessedBlobResolved = (payload = {}) => {
      const resolvedActionContext = resolveCompatibleActionContextFromPayload(payload);
      const processedBlob = payload?.processedBlob instanceof Blob
        ? payload.processedBlob
        : null;
      const sessionKey = (
        typeof resolvedActionContext?.sessionKey === 'string'
          ? resolvedActionContext.sessionKey.trim()
          : ''
      ) || imageSessionStore.getOrCreateByAssetIds(resolvedActionContext?.assetIds);
      const urlApi = targetWindow?.URL || globalThis.URL;
      if (!processedBlob || !sessionKey || typeof urlApi?.createObjectURL !== 'function') {
        return;
      }

      const previousFullObjectUrl = imageSessionStore.getSnapshot(sessionKey)?.derived?.processedSlots?.full?.objectUrl || '';
      const nextObjectUrl = urlApi.createObjectURL(processedBlob);
      if (
        previousFullObjectUrl
        && previousFullObjectUrl !== nextObjectUrl
        && typeof urlApi?.revokeObjectURL === 'function'
      ) {
        urlApi.revokeObjectURL(previousFullObjectUrl);
      }

      imageSessionStore.updateProcessedResult(sessionKey, {
        slot: 'full',
        objectUrl: nextObjectUrl,
        blob: processedBlob,
        blobType: processedBlob.type || 'image/png',
        processedFrom: resolvedActionContext?.action === 'clipboard'
          ? 'original-clipboard'
          : 'original-download'
      });
    };
    const downloadIntentGate = createGeminiDownloadIntentGate({
      targetWindow,
      resolveActionContext: (target) => {
        const intentAction = resolveGeminiActionKind(target) || 'clipboard';
        const sessionContext = actionContextResolver.resolveActionContext(target, {
          action: intentAction
        });
        return {
          action: intentAction,
          target,
          assetIds: sessionContext.assetIds,
          sessionKey: sessionContext.sessionKey,
          resource: sessionContext.resource,
          imageElement: sessionContext.imageElement || actionContextResolver.resolveImageElement({
            target,
            assetIds: sessionContext.assetIds
          })
        };
      }
    });
    const downloadRpcFetch = createGeminiDownloadRpcFetchHook({
      originalFetch: targetWindow.fetch.bind(targetWindow),
      getActionContext: () => downloadIntentGate.getRecentActionContext(),
      onOriginalAssetDiscovered: handleRpcAssetDiscovered,
      logger: console
    });
    installGeminiDownloadRpcXmlHttpRequestHook(targetWindow, {
      getActionContext: () => downloadIntentGate.getRecentActionContext(),
      onOriginalAssetDiscovered: handleRpcAssetDiscovered,
      logger: console
    });
    installGeminiDownloadHook(targetWindow, {
      originalFetch: downloadRpcFetch,
      intentGate: downloadIntentGate,
      isTargetUrl: isGeminiOriginalAssetUrl,
      normalizeUrl: normalizeGoogleusercontentImageUrl,
      processBlob: removeWatermarkFromBestAvailablePath,
      onOriginalAssetDiscovered: handleOriginalAssetDiscovered,
      onProcessedBlobResolved: handleProcessedBlobResolved,
      onActionCriticalFailure: handleActionCriticalFailure,
      logger: console
    });
    const disposeClipboardHook = installGeminiClipboardImageHook(targetWindow, {
      getActionContext: () => downloadIntentGate.getRecentActionContext(),
      imageSessionStore: imageSessionStore,
      onActionCriticalFailure: handleActionCriticalFailure,
      resolveImageElement: (actionContext) => actionContextResolver.resolveImageElement(actionContext),
      logger: console
    });
    await requestGeminiConversationHistoryBindings({
      targetWindow,
      fetchImpl: targetWindow.fetch.bind(targetWindow),
      onResponseText: async (responseText, { request }) => {
        for (const binding of extractGeminiAssetBindingsFromResponseText(responseText)) {
          handleRpcAssetDiscovered(appendCompatibleActionContext({
            rpcUrl: request?.url || '',
            discoveredUrl: binding.discoveredUrl
          }, {
            assetIds: binding.assetIds
          }));
        }
      },
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

    const pageImageReplacementController = isPreviewReplacementEnabled(targetWindow)
      ? installPageImageReplacement({
        imageSessionStore: imageSessionStore,
        logger: console,
        fetchPreviewBlob: previewBlobFetcher,
        processWatermarkBlobImpl: pageProcessClient.processWatermarkBlob,
        removeWatermarkFromBlobImpl: pageProcessClient.removeWatermarkFromBlob
      })
      : null;

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
