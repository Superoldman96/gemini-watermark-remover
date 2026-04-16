import { createUserscriptProcessingRuntime } from '../userscript/processingRuntime.js';

export function createUserscriptRuntimeProcessor(options = {}) {
  const runtime = createUserscriptProcessingRuntime(options);

  const processor = {
    initialize() {
      return runtime.initialize();
    },
    processWatermarkBlob(blob, processingOptions = {}) {
      return runtime.processWatermarkBlob(blob, processingOptions);
    },
    async removeWatermarkFromBlob(blob, processingOptions = {}) {
      return (await processor.processWatermarkBlob(blob, processingOptions)).processedBlob;
    },
    dispose(reason) {
      runtime.dispose(reason);
    }
  };

  return processor;
}
