import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getCallSource,
  getConstArrayItems,
  hasImportedBinding,
  loadModuleSource,
  normalizeWhitespace
} from '../testUtils/moduleStructure.js';

test('userscript entry should install download hook and page image replacement without default active click interception', () => {
  const source = loadModuleSource('../../src/userscript/index.js', import.meta.url);

  assert.equal(hasImportedBinding(source, './downloadHook.js', 'installGeminiDownloadHook'), true);
  assert.equal(hasImportedBinding(source, './downloadHook.js', 'createGeminiDownloadRpcFetchHook'), true);
  assert.equal(hasImportedBinding(source, './downloadHook.js', 'installGeminiDownloadRpcXmlHttpRequestHook'), true);
  assert.equal(hasImportedBinding(source, '../shared/pageImageReplacement.js', 'installPageImageReplacement'), true);
  assert.equal(hasImportedBinding(source, './historyBindingBootstrap.js', 'requestGeminiConversationHistoryBindings'), true);
  assert.equal(hasImportedBinding(source, './processBridge.js', 'installUserscriptProcessBridge'), true);
   assert.equal(hasImportedBinding(source, './pageProcessBridge.js', 'createPageProcessBridgeClient'), true);
   assert.equal(hasImportedBinding(source, './pageProcessorRuntime.js', 'installInjectedPageProcessorRuntime'), true);
  assert.equal(hasImportedBinding(source, './downloadClick.js', 'installGeminiDownloadClickHandler'), false);
});

test('userscript entry should skip initialization inside nested frames', () => {
  const source = loadModuleSource('../../src/userscript/index.js', import.meta.url);

  assert.match(normalizeWhitespace(source), /function shouldSkipFrame\(targetWindow\)/);
  assert.match(normalizeWhitespace(source), /if \(shouldSkipFrame\(targetWindow\)\) \{ return; \}/);
});

test('userscript entry should explicitly pass GM_xmlhttpRequest to preview fetching', () => {
  const source = loadModuleSource('../../src/userscript/index.js', import.meta.url);
  const createBlobFetcherCall = normalizeWhitespace(getCallSource(source, 'createUserscriptBlobFetcher'));

  assert.match(createBlobFetcherCall, /gmRequest:\s*userscriptRequest/);
  assert.match(normalizeWhitespace(source), /typeof GM_xmlhttpRequest === 'function'/);
});

test('userscript entry should not eagerly warm the main-thread engine during init', () => {
  const source = loadModuleSource('../../src/userscript/index.js', import.meta.url);

  assert.doesNotMatch(normalizeWhitespace(source), /getEngine\(\)\.catch/);
});

test('userscript entry should verify inline worker readiness before enabling acceleration', () => {
  const source = loadModuleSource('../../src/userscript/processingRuntime.js', import.meta.url);

  assert.match(normalizeWhitespace(source), /await workerClient\.ping\(\)/);
  assert.match(normalizeWhitespace(source), /Worker initialization failed,\s*using main thread/);
});

test('userscript entry should route page image processing through page runtime bridge with processingRuntime fallback', () => {
  const source = loadModuleSource('../../src/userscript/index.js', import.meta.url);
  const installDownloadHookCall = normalizeWhitespace(getCallSource(source, 'installGeminiDownloadHook'));
  const installDownloadRpcHookCall = normalizeWhitespace(getCallSource(source, 'createGeminiDownloadRpcFetchHook'));
  const installDownloadRpcXhrHookCall = normalizeWhitespace(getCallSource(source, 'installGeminiDownloadRpcXmlHttpRequestHook'));
  const installPageReplacementCall = normalizeWhitespace(getCallSource(source, 'installPageImageReplacement'));

  assert.equal(hasImportedBinding(source, './urlUtils.js', 'isGeminiOriginalAssetUrl'), true);
  assert.match(normalizeWhitespace(source), /await installInjectedPageProcessorRuntime\(/);
  assert.match(installDownloadHookCall, /isTargetUrl:\s*isGeminiOriginalAssetUrl/);
  assert.match(installDownloadRpcHookCall, /getIntentMetadata:\s*\(\)\s*=>\s*downloadIntentGate\.getRecentIntentMetadata\(\)/);
  assert.match(installDownloadRpcXhrHookCall, /getIntentMetadata:\s*\(\)\s*=>\s*downloadIntentGate\.getRecentIntentMetadata\(\)/);
  assert.match(normalizeWhitespace(source), /const removeWatermarkFromBestAvailablePath = \(blob,\s*options = \{\}\) => \(\s*pageProcessClient\?\.removeWatermarkFromBlob\s*\?\s*pageProcessClient\.removeWatermarkFromBlob\(blob,\s*options\)\s*:\s*processingRuntime\.removeWatermarkFromBlob\(blob,\s*options\)\s*\)/);
  assert.match(installDownloadHookCall, /processBlob:\s*removeWatermarkFromBestAvailablePath/);
  assert.match(installPageReplacementCall, /processWatermarkBlobImpl:\s*pageProcessClient\.processWatermarkBlob/);
  assert.match(installPageReplacementCall, /removeWatermarkFromBlobImpl:\s*pageProcessClient\.removeWatermarkFromBlob/);
  assert.doesNotMatch(installPageReplacementCall, /bridgeClient\./);
});

test('userscript entry should preserve the intent target for fullscreen clipboard fallback resolution', () => {
  const source = loadModuleSource('../../src/userscript/index.js', import.meta.url);
  const intentGateCall = normalizeWhitespace(getCallSource(source, 'createGeminiDownloadIntentGate'));
  const clipboardHookCall = normalizeWhitespace(getCallSource(source, 'installGeminiClipboardImageHook'));

  assert.match(intentGateCall, /resolveMetadata:\s*\(target\)\s*=>\s*\{/);
  assert.match(intentGateCall, /target,/);
  assert.match(intentGateCall, /const imageElement = findNearbyGeminiImageElement\(targetWindow,\s*target,\s*null\)/);
  assert.match(intentGateCall, /const assetIds = extractGeminiImageAssetIds\(target\)\s*\|\|\s*extractGeminiImageAssetIds\(imageElement\)/);
  assert.match(intentGateCall, /imageElement:\s*imageElement\s*\|\|\s*findNearbyGeminiImageElement\(targetWindow,\s*target,\s*assetIds\)/);
  assert.match(clipboardHookCall, /resolveImageElement:\s*\(intentMetadata\)\s*=>\s*findNearbyGeminiImageElement\(\s*targetWindow,\s*intentMetadata\?\.target\s*\|\|\s*null,\s*intentMetadata\?\.assetIds\s*\|\|\s*null\s*\)/);
});

test('userscript entry should search fullscreen dialog containers when resolving nearby Gemini images', () => {
  const source = normalizeWhitespace(loadModuleSource('../../src/userscript/index.js', import.meta.url));

  assert.equal(
    source.includes(
      "buttonLike?.closest?.('expansion-dialog,[role=\"dialog\"],.image-expansion-dialog-panel,.cdk-overlay-pane')"
    ),
    true
  );
});

test('userscript entry should prefer a processed global asset match when fullscreen image is still unprocessed', () => {
  const source = normalizeWhitespace(loadModuleSource('../../src/userscript/index.js', import.meta.url));

  assert.equal(
    source.includes('const globalAssetMatch = assetIds ? findGeminiImageElementForAssetIds(targetWindow?.document || document, assetIds) : null;'),
    true
  );
  assert.equal(
    source.includes('if (globalAssetMatch?.dataset?.gwrWatermarkObjectUrl) { return globalAssetMatch; }'),
    true
  );
  assert.equal(
    source.includes('fallbackMatch ||= imageElement;'),
    true
  );
});

test('userscript entry should install original-asset discovery hooks before async runtime initialization', () => {
  const source = normalizeWhitespace(loadModuleSource('../../src/userscript/index.js', import.meta.url));

  const rpcHookIndex = source.indexOf('const downloadRpcFetch = createGeminiDownloadRpcFetchHook(');
  const xhrHookIndex = source.indexOf('installGeminiDownloadRpcXmlHttpRequestHook(targetWindow,');
  const downloadHookIndex = source.indexOf('installGeminiDownloadHook(targetWindow,');
  const historyBootstrapIndex = source.indexOf('await requestGeminiConversationHistoryBindings(');
  const runtimeInitIndex = source.indexOf('await processingRuntime.initialize()');
  const pageRuntimeInitIndex = source.indexOf('await installInjectedPageProcessorRuntime(');

  assert.ok(rpcHookIndex >= 0, 'expected rpc fetch hook setup in userscript entry');
  assert.ok(xhrHookIndex >= 0, 'expected rpc xhr hook setup in userscript entry');
  assert.ok(downloadHookIndex >= 0, 'expected download hook setup in userscript entry');
  assert.ok(historyBootstrapIndex >= 0, 'expected conversation history bootstrap in userscript entry');
  assert.ok(runtimeInitIndex >= 0, 'expected processing runtime initialization in userscript entry');
  assert.ok(pageRuntimeInitIndex >= 0, 'expected page runtime initialization in userscript entry');
  assert.ok(rpcHookIndex < runtimeInitIndex, 'rpc fetch hook should be installed before processing runtime initialize await');
  assert.ok(xhrHookIndex < runtimeInitIndex, 'rpc xhr hook should be installed before processing runtime initialize await');
  assert.ok(downloadHookIndex < runtimeInitIndex, 'download hook should be installed before processing runtime initialize await');
  assert.ok(historyBootstrapIndex < runtimeInitIndex, 'conversation history bootstrap should run before processing runtime initialize await');
  assert.ok(rpcHookIndex < pageRuntimeInitIndex, 'rpc fetch hook should be installed before page runtime injection await');
  assert.ok(xhrHookIndex < pageRuntimeInitIndex, 'rpc xhr hook should be installed before page runtime injection await');
  assert.ok(downloadHookIndex < pageRuntimeInitIndex, 'download hook should be installed before page runtime injection await');
  assert.ok(historyBootstrapIndex < pageRuntimeInitIndex, 'conversation history bootstrap should run before page runtime injection await');
});

test('userscript entry should delegate watermark runtime logic to processingRuntime module', () => {
  const source = loadModuleSource('../../src/userscript/index.js', import.meta.url);
  const bridgeInstallCall = normalizeWhitespace(getCallSource(source, 'installUserscriptProcessBridge'));

  assert.equal(hasImportedBinding(source, './processingRuntime.js', 'createUserscriptProcessingRuntime'), true);
  assert.match(normalizeWhitespace(source), /const processingRuntime = createUserscriptProcessingRuntime\(/);
  assert.match(normalizeWhitespace(source), /await processingRuntime\.initialize\(\)/);
  assert.match(bridgeInstallCall, /processWatermarkBlob:\s*processingRuntime\.processWatermarkBlob/);
  assert.match(bridgeInstallCall, /removeWatermarkFromBlob:\s*processingRuntime\.removeWatermarkFromBlob/);
});

test('userscript entry should not inline duplicate worker runtime implementation', () => {
  const source = loadModuleSource('../../src/userscript/index.js', import.meta.url);

  assert.doesNotMatch(normalizeWhitespace(source), /class InlineWorkerClient/);
  assert.doesNotMatch(normalizeWhitespace(source), /function getEngine\(/);
  assert.doesNotMatch(normalizeWhitespace(source), /function processBlobWithBestPath\(/);
});

test('page image replacement should not observe self-written stable source attributes', () => {
  const source = loadModuleSource('../../src/shared/pageImageReplacement.js', import.meta.url);
  const observedAttributes = getConstArrayItems(source, 'OBSERVED_ATTRIBUTES');
  assert.equal(observedAttributes.includes('data-gwr-stable-source'), false);
});
