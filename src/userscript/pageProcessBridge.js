import { normalizeErrorMessage } from '../shared/errorUtils.js';

export const PAGE_PROCESS_REQUEST = 'gwr:page-process-request';
export const PAGE_PROCESS_RESPONSE = 'gwr:page-process-response';

const PAGE_PROCESS_BRIDGE_FLAG = '__gwrPageProcessBridgeInstalled__';

function isAllowedMessageSource(eventSource, targetWindow) {
  if (!targetWindow || !eventSource) {
    return true;
  }
  if (eventSource === targetWindow) {
    return true;
  }

  try {
    if (eventSource.window === targetWindow || eventSource.self === targetWindow) {
      return true;
    }
  } catch {}

  try {
    if (targetWindow.window === eventSource || targetWindow.self === eventSource) {
      return true;
    }
  } catch {}

  return false;
}

function buildBlobResult(processedBlob, processedMeta = null) {
  return {
    processedBlob,
    processedMeta
  };
}

async function blobResultToPayload(result) {
  const normalizedResult = result instanceof Blob
    ? buildBlobResult(result, null)
    : buildBlobResult(result?.processedBlob, result?.processedMeta ?? null);
  const processedBlob = normalizedResult.processedBlob;
  if (!(processedBlob instanceof Blob)) {
    throw new Error('Page bridge processor must return a Blob');
  }

  const processedBuffer = await processedBlob.arrayBuffer();
  return {
    processedBuffer,
    mimeType: processedBlob.type || 'image/png',
    meta: normalizedResult.processedMeta ?? null
  };
}

export function createPageProcessBridgeServer({
  targetWindow = globalThis.window || null,
  processWatermarkBlob,
  removeWatermarkFromBlob,
  logger = console
} = {}) {
  return async function handlePageProcessBridge(event) {
    if (!event?.data || event.data.type !== PAGE_PROCESS_REQUEST) {
      return;
    }
    if (!isAllowedMessageSource(event?.source, targetWindow)) {
      return;
    }
    if (!targetWindow || typeof targetWindow.postMessage !== 'function') {
      return;
    }

    const requestId = typeof event.data.requestId === 'string' ? event.data.requestId : '';
    const action = typeof event.data.action === 'string' ? event.data.action : '';
    if (!requestId || !action) {
      return;
    }

    try {
      const inputBlob = new Blob([event.data.inputBuffer], {
        type: event.data.mimeType || 'image/png'
      });
      let result;
      if (action === 'process-watermark-blob') {
        if (typeof processWatermarkBlob !== 'function') {
          throw new Error('processWatermarkBlob page bridge handler unavailable');
        }
        result = await processWatermarkBlob(inputBlob, event.data.options || {});
      } else if (action === 'remove-watermark-blob') {
        if (typeof removeWatermarkFromBlob !== 'function') {
          throw new Error('removeWatermarkFromBlob page bridge handler unavailable');
        }
        result = await removeWatermarkFromBlob(inputBlob, event.data.options || {});
      } else {
        throw new Error(`Unknown page bridge action: ${action}`);
      }

      const payload = await blobResultToPayload(result);
      targetWindow.postMessage({
        type: PAGE_PROCESS_RESPONSE,
        requestId,
        ok: true,
        action,
        result: payload
      }, '*', [payload.processedBuffer]);
    } catch (error) {
      logger?.warn?.('[Gemini Watermark Remover] Page bridge request failed:', error);
      targetWindow.postMessage({
        type: PAGE_PROCESS_RESPONSE,
        requestId,
        ok: false,
        action,
        error: normalizeErrorMessage(error, 'Page bridge failed')
      }, '*');
    }
  };
}

export function installPageProcessBridge(options = {}) {
  const {
    targetWindow = globalThis.window || null
  } = options;

  if (!targetWindow || typeof targetWindow.addEventListener !== 'function') {
    return null;
  }
  if (targetWindow[PAGE_PROCESS_BRIDGE_FLAG]) {
    return targetWindow[PAGE_PROCESS_BRIDGE_FLAG];
  }

  const handler = createPageProcessBridgeServer({
    ...options,
    targetWindow
  });

  const listener = (event) => {
    void handler(event);
  };
  targetWindow.addEventListener('message', listener);
  targetWindow[PAGE_PROCESS_BRIDGE_FLAG] = {
    handler,
    dispose() {
      targetWindow.removeEventListener?.('message', listener);
      delete targetWindow[PAGE_PROCESS_BRIDGE_FLAG];
    }
  };
  return targetWindow[PAGE_PROCESS_BRIDGE_FLAG];
}

function createRequestId() {
  return `gwr-page-bridge-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function createBlobResultFromResponse(result = {}) {
  return {
    processedBlob: new Blob([result.processedBuffer], {
      type: result.mimeType || 'image/png'
    }),
    processedMeta: result.meta ?? null
  };
}

export function createPageProcessBridgeClient({
  targetWindow = globalThis.window || null,
  timeoutMs = 120000,
  fallbackProcessWatermarkBlob,
  fallbackRemoveWatermarkFromBlob,
  logger = console
} = {}) {
  async function request(action, blob, options, fallback) {
    if (!(blob instanceof Blob)) {
      throw new TypeError('blob must be a Blob');
    }

    if (
      !targetWindow
      || typeof targetWindow.addEventListener !== 'function'
      || typeof targetWindow.removeEventListener !== 'function'
      || typeof targetWindow.postMessage !== 'function'
    ) {
      return fallback(blob, options);
    }

    const inputBuffer = await blob.arrayBuffer();
    const requestId = createRequestId();

    try {
      return await new Promise((resolve, reject) => {
        const cleanup = () => {
          targetWindow.removeEventListener('message', handleMessage);
          globalThis.clearTimeout(timeoutId);
        };

        const handleMessage = (event) => {
          if (!isAllowedMessageSource(event?.source, targetWindow)) {
            return;
          }
          if (!event?.data || event.data.type !== PAGE_PROCESS_RESPONSE) {
            return;
          }
          if (event.data.requestId !== requestId) {
            return;
          }

          cleanup();
          if (event.data.ok === false) {
            reject(new Error(normalizeErrorMessage(event.data.error, 'Page bridge failed')));
            return;
          }
          resolve(createBlobResultFromResponse(event.data.result));
        };

        const timeoutId = globalThis.setTimeout(() => {
          cleanup();
          reject(new Error(`Page bridge timed out: ${action}`));
        }, timeoutMs);

        targetWindow.addEventListener('message', handleMessage);
        targetWindow.postMessage({
          type: PAGE_PROCESS_REQUEST,
          requestId,
          action,
          inputBuffer,
          mimeType: blob.type || 'image/png',
          options: options || {}
        }, '*', [inputBuffer]);
      });
    } catch (error) {
      logger?.warn?.('[Gemini Watermark Remover] Page bridge fallback:', error);
      return fallback(blob, options);
    }
  }

  return {
    async processWatermarkBlob(blob, options = {}) {
      if (typeof fallbackProcessWatermarkBlob !== 'function') {
        throw new Error('fallbackProcessWatermarkBlob must be a function');
      }
      return request('process-watermark-blob', blob, options, fallbackProcessWatermarkBlob);
    },
    async removeWatermarkFromBlob(blob, options = {}) {
      if (typeof fallbackRemoveWatermarkFromBlob !== 'function') {
        throw new Error('fallbackRemoveWatermarkFromBlob must be a function');
      }
      const result = await request('remove-watermark-blob', blob, options, async (inputBlob, inputOptions) => {
        const processedBlob = await fallbackRemoveWatermarkFromBlob(inputBlob, inputOptions);
        return buildBlobResult(processedBlob, null);
      });
      return result.processedBlob;
    }
  };
}
