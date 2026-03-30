import { WatermarkEngine } from '../core/watermarkEngine.js';
import { canvasToBlob } from '../core/canvasBlob.js';
import { installPageProcessBridge } from '../userscript/pageProcessBridge.js';

const PAGE_PROCESS_RUNTIME_FLAG = '__gwrPageProcessRuntimeInstalled__';

const loadImage = (src) => new Promise((resolve, reject) => {
  const img = new Image();
  img.onload = () => resolve(img);
  img.onerror = reject;
  img.src = src;
});

export function installPageProcessRuntime({
  targetWindow = globalThis.window || null,
  logger = console
} = {}) {
  if (!targetWindow) {
    return null;
  }
  if (targetWindow[PAGE_PROCESS_RUNTIME_FLAG]) {
    return targetWindow[PAGE_PROCESS_RUNTIME_FLAG];
  }

  let enginePromise = null;
  async function getEngine() {
    if (!enginePromise) {
      enginePromise = WatermarkEngine.create().catch((error) => {
        enginePromise = null;
        throw error;
      });
    }
    return enginePromise;
  }

  async function processWatermarkBlob(blob, options = {}) {
    const engine = await getEngine();
    const blobUrl = URL.createObjectURL(blob);
    try {
      const img = await loadImage(blobUrl);
      const canvas = await engine.removeWatermarkFromImage(img, options);
      const processedBlob = await canvasToBlob(canvas);
      return {
        processedBlob,
        processedMeta: canvas.__watermarkMeta || null
      };
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  }

  async function removeWatermarkFromBlob(blob, options = {}) {
    return (await processWatermarkBlob(blob, options)).processedBlob;
  }

  const bridge = installPageProcessBridge({
    targetWindow,
    processWatermarkBlob,
    removeWatermarkFromBlob,
    logger
  });

  targetWindow[PAGE_PROCESS_RUNTIME_FLAG] = {
    bridge,
    processWatermarkBlob,
    removeWatermarkFromBlob,
    dispose() {
      bridge?.dispose?.();
      delete targetWindow[PAGE_PROCESS_RUNTIME_FLAG];
    }
  };
  return targetWindow[PAGE_PROCESS_RUNTIME_FLAG];
}
