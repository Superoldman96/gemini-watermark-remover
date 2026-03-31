import { canvasToBlob } from '../core/canvasBlob.js';
import { WatermarkEngine } from '../core/watermarkEngine.js';

function loadImageFromObjectUrl(objectUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Failed to decode Gemini image blob'));
    image.src = objectUrl;
  });
}

async function loadRenderableFromBlobFallback(blob, originalError) {
  if (typeof createImageBitmap !== 'function') {
    throw originalError;
  }

  try {
    return await createImageBitmap(blob);
  } catch {
    throw originalError;
  }
}

export async function loadImageFromBlob(blob) {
  const objectUrl = URL.createObjectURL(blob);
  try {
    try {
      return await loadImageFromObjectUrl(objectUrl);
    } catch (error) {
      return await loadRenderableFromBlobFallback(blob, error);
    }
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function withProcessorPath(meta, processorPath) {
  return {
    ...(meta && typeof meta === 'object' ? meta : {}),
    processorPath
  };
}

function normalizeProcessorResult(result, processorPath = 'main-thread') {
  return {
    processedBlob: result?.processedBlob || null,
    processedMeta: withProcessorPath(result?.processedMeta || null, processorPath)
  };
}

function normalizeProcessingOptions(options = {}) {
  return {
    adaptiveMode: 'always',
    ...(options && typeof options === 'object' ? options : {})
  };
}

export function createCachedImageProcessor({
  createEngine = () => WatermarkEngine.create(),
  encodeCanvas = canvasToBlob,
  processorPath = 'main-thread'
} = {}) {
  let enginePromise = null;

  async function getEngine() {
    if (!enginePromise) {
      enginePromise = Promise.resolve(createEngine()).catch((error) => {
        enginePromise = null;
        throw error;
      });
    }
    return enginePromise;
  }

  return async function processRenderable(image, options = {}) {
    const engine = await getEngine();
    const normalizedOptions = normalizeProcessingOptions(options);
    const canvas = await engine.removeWatermarkFromImage(image, normalizedOptions);

    return {
      processedBlob: await encodeCanvas(canvas),
      processedMeta: withProcessorPath(canvas.__watermarkMeta || null, processorPath)
    };
  };
}

export function createMainThreadBlobProcessor({
  loadRenderable = loadImageFromBlob,
  processRenderable = createCachedImageProcessor()
} = {}) {
  return async function processBlobOnMainThread(blob, options = {}) {
    const image = await loadRenderable(blob);
    return processRenderable(image, options);
  };
}

export function createSharedBlobProcessor({
  processMainThread = createMainThreadBlobProcessor(),
  getWorkerProcessor = null,
  onWorkerError = null
} = {}) {
  return async function processWithBestPath(blob, options = { adaptiveMode: 'always' }) {
    const normalizedOptions = normalizeProcessingOptions(options);
    const processWorker = typeof getWorkerProcessor === 'function'
      ? getWorkerProcessor()
      : null;

    if (typeof processWorker === 'function') {
      try {
        return await processWorker(blob, normalizedOptions);
      } catch (error) {
        onWorkerError?.(error);
      }
    }

    return normalizeProcessorResult(
      await processMainThread(blob, normalizedOptions),
      'main-thread'
    );
  };
}

export const processWatermarkBlobOnMainThread = createMainThreadBlobProcessor();
const processWatermarkBlobWithBestPath = createSharedBlobProcessor();

export async function processWatermarkBlob(blob, options = { adaptiveMode: 'always' }) {
  return processWatermarkBlobWithBestPath(blob, options);
}

export async function removeWatermarkFromBlob(blob, options = { adaptiveMode: 'always' }) {
  const result = await processWatermarkBlob(blob, options);
  return result.processedBlob;
}
