import { createActionContextProvider } from '../shared/actionContextCompat.js';
import { resolveImageSessionContext } from '../shared/imageSessionContext.js';
import { getDefaultImageSessionStore } from '../shared/imageSessionStore.js';

function isImageMimeType(type) {
  return typeof type === 'string' && /^image\//i.test(type);
}

function isBlobUrl(url) {
  return typeof url === 'string' && /^blob:/i.test(url);
}

function canvasToBlob(canvas, type = 'image/png') {
  return new Promise((resolve, reject) => {
    if (!canvas || typeof canvas.toBlob !== 'function') {
      reject(new Error('Canvas toBlob unavailable'));
      return;
    }
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
        return;
      }
      reject(new Error('Canvas toBlob returned null'));
    }, type);
  });
}

async function createBlobFromObjectUrlImage(objectUrl, imageElement, targetWindow = globalThis) {
  const ImageClass = targetWindow?.Image || globalThis.Image;
  const documentRef = imageElement?.ownerDocument || targetWindow?.document || globalThis.document;
  if (typeof ImageClass !== 'function' || !documentRef?.createElement) {
    throw new Error('Image decode fallback unavailable');
  }

  const image = new ImageClass();
  image.decoding = 'async';
  image.src = objectUrl;
  if (typeof image.decode === 'function') {
    await image.decode();
  } else {
    await new Promise((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('Failed to load processed object URL'));
    });
  }

  const width = Number(image.naturalWidth) || Number(image.width) || Number(imageElement?.naturalWidth) || Number(imageElement?.width) || 0;
  const height = Number(image.naturalHeight) || Number(image.height) || Number(imageElement?.naturalHeight) || Number(imageElement?.height) || 0;
  if (width <= 0 || height <= 0) {
    throw new Error('Processed object URL image has no renderable size');
  }

  const canvas = documentRef.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext?.('2d', { willReadFrequently: true });
  if (!context) {
    throw new Error('2D canvas context unavailable');
  }
  context.drawImage(image, 0, 0, width, height);
  return canvasToBlob(canvas, 'image/png');
}

async function buildClipboardReplacementItems(items, replacementBlob, ClipboardItemClass) {
  const replacementItems = [];
  let replacedAny = false;

  for (const item of Array.from(items || [])) {
    const types = Array.isArray(item?.types) ? item.types.filter(Boolean) : [];
    if (!types.some(isImageMimeType) || typeof ClipboardItemClass !== 'function') {
      replacementItems.push(item);
      continue;
    }

    const replacementData = {};
    for (const type of types) {
      if (isImageMimeType(type)) {
        continue;
      }
      if (typeof item.getType === 'function') {
        replacementData[type] = item.getType(type);
      }
    }

    replacementData[replacementBlob.type || 'image/png'] = replacementBlob;
    replacementItems.push(new ClipboardItemClass(replacementData));
    replacedAny = true;
  }

  return replacedAny ? replacementItems : items;
}

async function resolveProcessedClipboardBlob({
  actionContext = null,
  resolveImageElement,
  imageSessionStore = getDefaultImageSessionStore(),
  fetchBlobDirect,
  resolveBlobViaImageElement
}) {
  const sessionContext = resolveImageSessionContext({
    action: 'clipboard',
    actionContext,
    resolveImageElement,
    imageSessionStore
  });
  const imageElement = sessionContext?.imageElement || actionContext?.imageElement || null;
  const sessionBlob = sessionContext?.resource?.kind === 'processed'
    && sessionContext.resource.blob instanceof Blob
    ? sessionContext.resource.blob
    : null;
  if (sessionBlob) {
    return sessionBlob;
  }
  const resourceUrl = sessionContext?.resource?.kind === 'processed'
    && typeof sessionContext.resource.url === 'string'
    ? sessionContext.resource.url.trim()
    : '';
  const objectUrl = resourceUrl || (
    typeof imageElement?.dataset?.gwrWatermarkObjectUrl === 'string'
      ? imageElement.dataset.gwrWatermarkObjectUrl.trim()
      : ''
  );
  if (!objectUrl) {
    return null;
  }

  if (imageElement && isBlobUrl(objectUrl) && typeof resolveBlobViaImageElement === 'function') {
    try {
      return await resolveBlobViaImageElement({
        objectUrl,
        imageElement
      });
    } catch (error) {
      if (typeof fetchBlobDirect !== 'function') {
        throw error;
      }
    }
  }

  if (typeof fetchBlobDirect !== 'function') {
    return null;
  }

  return fetchBlobDirect(objectUrl);
}

export function installGeminiClipboardImageHook(targetWindow, {
  provideActionContext = null,
  getActionContext = () => null,
  resolveImageElement = null,
  imageSessionStore = getDefaultImageSessionStore(),
  fetchBlobDirect = async (url) => {
    const response = await fetch(url);
    return response.blob();
  },
  resolveBlobViaImageElement = ({ objectUrl, imageElement }) => (
    createBlobFromObjectUrlImage(objectUrl, imageElement, targetWindow)
  ),
  logger = console
} = {}) {
  const clipboard = targetWindow?.navigator?.clipboard;
  if (!clipboard || typeof clipboard.write !== 'function') {
    return () => {};
  }

  const originalWrite = clipboard.write.bind(clipboard);
  const ClipboardItemClass = targetWindow?.ClipboardItem || globalThis.ClipboardItem;
  const resolveActionContextProvider = typeof provideActionContext === 'function'
    ? provideActionContext
    : createActionContextProvider({ getActionContext });

  const hookedWrite = async function gwrClipboardWriteHook(items) {
    try {
      const actionContext = resolveActionContextProvider();
      const processedBlob = await resolveProcessedClipboardBlob({
        actionContext,
        resolveImageElement,
        imageSessionStore,
        fetchBlobDirect,
        resolveBlobViaImageElement
      });
      if (!processedBlob) {
        return originalWrite(items);
      }

      const replacementItems = await buildClipboardReplacementItems(
        items,
        processedBlob,
        ClipboardItemClass
      );
      return originalWrite(replacementItems);
    } catch (error) {
      logger?.warn?.('[Gemini Watermark Remover] Clipboard image hook failed, falling back:', error);
      return originalWrite(items);
    }
  };
  clipboard.write = hookedWrite;

  return () => {
    if (clipboard.write === hookedWrite) {
      clipboard.write = originalWrite;
    }
  };
}
