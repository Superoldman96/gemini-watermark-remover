# Phase 2 Preview Request-Layer Interceptor Implementation Plan

> Status note (2026-04-06): This plan is now partially superseded by real-page validation. Current production direction is:
> - keep `copy/download` on the request-layer path
> - keep preview request interception enabled as an assisting source
> - keep `src/shared/pageImageReplacement.js` as the production preview display path
> - do not continue forcing request-layer preview interception to become the sole or primary visible preview replacement path until Gemini's final displayed `blob:` ownership is proven stable

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the request-layer pipeline to Gemini `gg` preview assets so preview requests can contribute processed display resources and observability without weakening the already-validated copy/download contract.

**Architecture:** Reuse the existing `createGeminiDownloadFetchHook(...)` response-transform mechanism as a generalized generated-asset interceptor, but keep phase-1 strictness for copy/download intact. Keep preview-target interception in parallel with the existing DOM/page preview replacement path, and treat request-layer preview results as a supportive source rather than assuming `src/shared/pageImageReplacement.js` can already be retired.

**Tech Stack:** Userscript runtime, page `fetch` interception, shared image session store, Node `node:test`, fixed-profile Tampermonkey real-page validation

---

## File Structure

- Modify: `src/userscript/index.js`
  - install a second request-layer interception path for preview `gg` assets
  - keep original/full-quality interception behavior unchanged
  - keep DOM/page preview replacement enabled by default for real visible preview correctness
- Modify: `src/userscript/downloadHook.js`
  - rename or factor the generic hook semantics so the same response-transform helper can safely serve both preview and original/full-quality assets
  - preserve phase-1 fail-closed semantics only for action-critical copy/download flows
- Modify: `src/shared/imageSessionStore.js`
  - keep request-layer preview results available as display-oriented supportive resources
  - keep full-quality slots isolated for copy/download correctness
- Modify: `src/shared/pageImageReplacement.js`
  - keep the file as the production preview display lane
  - continue accepting request-layer preview results as optional assistive inputs
- Test: `tests/userscript/downloadHook.test.js`
  - add preview interception coverage beside current original/full-quality coverage
- Test: `tests/userscript/downloadOnlyEntry.test.js`
  - assert preview interception wiring exists while DOM replacement remains off by default
- Test: `tests/shared/imageSessionStore.test.js`
  - prove preview and full slots remain isolated after request-layer preview writes
- Test: `tests/shared/pageImageReplacement.test.js`
  - prove DOM preview replacement can still adopt request-layer preview results without surrendering visible preview ownership

### Task 1: Lock The Phase-2 Preview Contract With Tests

**Files:**
- Modify: `tests/userscript/downloadHook.test.js`
- Modify: `tests/userscript/downloadOnlyEntry.test.js`
- Modify: `tests/shared/imageSessionStore.test.js`

- [ ] **Step 1: Add a failing request-layer preview interception test**

Add a test near the existing `createGeminiDownloadFetchHook` coverage:

```js
test('createGeminiDownloadFetchHook should process Gemini preview fetches when preview interception is enabled', async () => {
  const seenUrls = [];
  const hook = createGeminiDownloadFetchHook({
    originalFetch: async (input) => {
      seenUrls.push(typeof input === 'string' ? input : input.url);
      return new Response(new Blob(['preview-original'], { type: 'image/webp' }), {
        status: 200,
        headers: { 'content-type': 'image/webp' }
      });
    },
    isTargetUrl: (url) => url.includes('/gg/'),
    normalizeUrl: () => 'https://lh3.googleusercontent.com/gg/token=s0-rj',
    processBlob: async (blob, context) => {
      assert.equal(await blob.text(), 'preview-original');
      assert.equal(context.normalizedUrl, 'https://lh3.googleusercontent.com/gg/token=s0-rj');
      return new Blob(['preview-processed'], { type: 'image/png' });
    }
  });

  const response = await hook('https://lh3.googleusercontent.com/gg/token=s1024-rj');

  assert.deepEqual(seenUrls, ['https://lh3.googleusercontent.com/gg/token=s0-rj']);
  assert.equal(await response.text(), 'preview-processed');
  assert.equal(response.headers.get('content-type'), 'image/png');
});
```

- [ ] **Step 2: Add a failing entry wiring test for preview interception**

Add a structure test proving the userscript entry wires preview interception separately from the original/full-quality path:

```js
test('userscript entry should install preview request interception while keeping DOM preview replacement off by default', () => {
  const source = loadModuleSource('../../src/userscript/index.js', import.meta.url);
  const normalized = normalizeWhitespace(source);

  assert.match(normalized, /isGeminiPreviewAssetUrl/);
  assert.match(normalized, /createGeminiDownloadFetchHook\(/);
  assert.match(normalized, /shouldProcessRequest:\s*\(\{ url = '' \} = \{\}\) =>/);
  assert.match(normalized, /const pageImageReplacementController = isPreviewReplacementEnabled\(targetWindow\)/);
});
```

- [ ] **Step 3: Add a failing session-store test for preview-slot isolation**

Add a regression test proving request-layer preview writes do not become copy/download resources:

```js
test('createImageSessionStore should keep request-layer preview resources display-only while full slot remains action-critical', () => {
  const store = createImageSessionStore();
  const sessionKey = store.getOrCreateByAssetIds({
    responseId: 'r_preview_phase2',
    draftId: 'rc_preview_phase2',
    conversationId: 'c_preview_phase2'
  });

  store.updateProcessedResult(sessionKey, {
    slot: 'preview',
    objectUrl: 'blob:https://gemini.google.com/preview-phase2',
    blob: new Blob(['preview'], { type: 'image/png' }),
    blobType: 'image/png',
    processedFrom: 'request-preview'
  });

  assert.equal(store.getBestResource(sessionKey, 'display')?.slot, 'preview');
  assert.equal(store.getBestResource(sessionKey, 'clipboard')?.slot, undefined);
  assert.equal(store.getBestResource(sessionKey, 'download')?.slot, undefined);
});
```

- [ ] **Step 4: Run the targeted tests and verify they fail for the expected reason**

Run:

```bash
node --test tests/userscript/downloadHook.test.js
node --test tests/userscript/downloadOnlyEntry.test.js
node --test tests/shared/imageSessionStore.test.js
```

Expected:

- the new preview interception assertions fail
- current entry wiring does not yet prove preview request-layer installation
- session-store behavior is unchanged or under-specified for request-layer preview ownership

- [ ] **Step 5: Commit the test-only checkpoint**

```bash
git add tests/userscript/downloadHook.test.js tests/userscript/downloadOnlyEntry.test.js tests/shared/imageSessionStore.test.js
git commit -m "test: lock phase-2 preview request-layer contract"
```

### Task 2: Generalize The Request Interceptor For Preview Assets

**Files:**
- Modify: `src/userscript/downloadHook.js`
- Test: `tests/userscript/downloadHook.test.js`

- [ ] **Step 1: Split the action-critical semantics from the generic response-transform helper**

Refactor the hook internals so generic interception can be reused for preview assets without forcing action-critical notifications on passive display work:

```js
function isActionCriticalContext(actionContext = null) {
  return actionContext?.action === 'clipboard' || actionContext?.action === 'download';
}
```

```js
if (typeof onActionCriticalFailure === 'function' && isActionCriticalContext(resolvedActionContext)) {
  await notifyActionCriticalFailure(...);
}
```

- [ ] **Step 2: Keep generic request normalization and in-flight caching shared**

Preserve the normalized-url cache contract:

```js
const normalizedUrl = normalizeUrl(url);
let pendingBlob = cache.get(normalizedUrl);
```

Do not duplicate this logic into a preview-only hook.

- [ ] **Step 3: Make processed-blob callbacks usable for preview results too**

Keep callback payload shape compatible with the full-quality path:

```js
await onProcessedBlobResolved?.(appendCompatibleActionContext({
  url,
  normalizedUrl,
  processedBlob,
  responseStatus: response.status,
  responseStatusText: response.statusText,
  responseHeaders: serializeResponseHeaders(response.headers)
}, resolvedActionContext));
```

- [ ] **Step 4: Run the focused hook tests**

Run:

```bash
node --test tests/userscript/downloadHook.test.js
```

Expected:

- original/full-quality hook tests remain green
- new preview interception test now passes

- [ ] **Step 5: Commit the generic interception refactor**

```bash
git add src/userscript/downloadHook.js tests/userscript/downloadHook.test.js
git commit -m "refactor: generalize generated asset response interception"
```

### Task 3: Wire Preview Request Interception In Userscript Entry

**Files:**
- Modify: `src/userscript/index.js`
- Test: `tests/userscript/downloadOnlyEntry.test.js`

- [ ] **Step 1: Create a display-oriented preview interception pipeline**

Add a preview processor beside the existing full-quality path:

```js
const processPreviewBlobAtBestPath = (blob, options = {}) => (
  pageProcessClient?.processWatermarkBlob
    ? pageProcessClient.processWatermarkBlob(blob, options)
    : processingRuntime.processWatermarkBlob(blob, options)
);
```

- [ ] **Step 2: Install a preview-targeted fetch hook before page rendering starts**

Wire the hook using preview URL classification:

```js
const previewFetch = createGeminiDownloadFetchHook({
  originalFetch: targetWindow.fetch.bind(targetWindow),
  isTargetUrl: isGeminiPreviewAssetUrl,
  normalizeUrl: normalizeGoogleusercontentImageUrl,
  processBlob: processPreviewBlobAtBestPath,
  shouldProcessRequest: ({ url = '' } = {}) => isGeminiPreviewAssetUrl(url),
  onProcessedBlobResolved: handlePreviewBlobResolved,
  logger: console
});
```

- [ ] **Step 3: Chain original/full-quality interception on top of preview interception**

Keep original/full asset handling downstream of the preview hook:

```js
installGeminiDownloadHook(targetWindow, {
  originalFetch: previewFetch,
  intentGate: downloadIntentGate,
  isTargetUrl: isGeminiOriginalAssetUrl,
  normalizeUrl: normalizeGoogleusercontentImageUrl,
  processBlob: removeWatermarkFromBestAvailablePath,
  ...
});
```

- [ ] **Step 4: Run entry wiring tests**

Run:

```bash
node --test tests/userscript/downloadOnlyEntry.test.js
```

Expected:

- entry tests prove preview interception wiring exists
- DOM replacement remains gated behind `isPreviewReplacementEnabled(...)`

- [ ] **Step 5: Commit the entry wiring change**

```bash
git add src/userscript/index.js tests/userscript/downloadOnlyEntry.test.js
git commit -m "feat: intercept preview assets at the request layer"
```

### Task 4: Persist Request-Layer Preview Results Into The Session Store

**Files:**
- Modify: `src/shared/imageSessionStore.js`
- Modify: `src/userscript/index.js`
- Test: `tests/shared/imageSessionStore.test.js`

- [ ] **Step 1: Add a dedicated preview result sink from request interception**

Use the existing `preview` slot instead of inventing a second display slot:

```js
imageSessionStore.updateProcessedResult(sessionKey, {
  slot: 'preview',
  objectUrl: nextObjectUrl,
  blob: processedBlob,
  blobType: processedBlob.type || 'image/png',
  processedFrom: 'request-preview'
});
```

- [ ] **Step 2: Preserve action-specific resource lookup**

Keep full-quality actions strict:

```js
if (isFullQualityAction(action)) {
  return fullProcessedResource || buildOriginalResource(session);
}
```

Do not let `request-preview` satisfy `clipboard` or `download`.

- [ ] **Step 3: Keep display lookup preferring request-layer preview output**

Display should continue preferring preview over full:

```js
if (previewProcessedResource) {
  return previewProcessedResource;
}
```

- [ ] **Step 4: Run the session-store tests**

Run:

```bash
node --test tests/shared/imageSessionStore.test.js
```

Expected:

- preview display lookup uses the request-layer preview result
- clipboard/download remain strict to full/original resources

- [ ] **Step 5: Commit the session-store integration**

```bash
git add src/shared/imageSessionStore.js src/userscript/index.js tests/shared/imageSessionStore.test.js
git commit -m "feat: store request-layer preview results in preview slot"
```

### Task 5: Keep DOM Preview Replacement As The Visible Display Lane

**Files:**
- Modify: `src/shared/pageImageReplacement.js`
- Test: `tests/shared/pageImageReplacement.test.js`

- [ ] **Step 1: Add a failing preview-assist behavior test**

Add a test proving the page replacement path can reuse request-layer preview resources without giving up visible preview ownership:

```js
test('processPageImageSource should reuse request-layer preview output when it is already present', async () => {
  const store = createImageSessionStore();
  const sessionKey = store.getOrCreateByAssetIds({
    responseId: 'r_phase2_skip',
    draftId: 'rc_phase2_skip',
    conversationId: 'c_phase2_skip'
  });

  store.updateProcessedResult(sessionKey, {
    slot: 'preview',
    objectUrl: 'blob:https://gemini.google.com/request-preview',
    blob: new Blob(['preview'], { type: 'image/png' }),
    blobType: 'image/png',
    processedFrom: 'request-preview'
  });

  // expect the page replacement path to adopt the remembered preview resource
});
```

- [ ] **Step 2: Prefer remembered preview resources before reprocessing**

Prefer the remembered request-layer preview resource when it is safe to adopt:

```js
if (existingPreviewResource?.kind === 'processed' && existingPreviewResource.slot === 'preview') {
  return adoptExistingProcessedPreviewResource(...);
}
```

- [ ] **Step 3: Run the page replacement tests**

Run:

```bash
node --test tests/shared/pageImageReplacement.test.js
```

Expected:

- existing preview replacement tests remain green
- new preview-assist regression passes

- [ ] **Step 4: Commit the preview-assist integration**

```bash
git add src/shared/pageImageReplacement.js tests/shared/pageImageReplacement.test.js
git commit -m "refactor: let page preview replacement adopt request preview results"
```

### Task 6: Verify Build And Fixed-Profile Real-Page Behavior

**Files:**
- Modify if needed during fixes: `src/userscript/index.js`
- Modify if needed during fixes: `src/userscript/downloadHook.js`
- Modify if needed during fixes: `src/shared/pageImageReplacement.js`

- [ ] **Step 1: Run the full automated suite**

Run:

```bash
pnpm test
pnpm build
```

Expected:

- full test suite passes
- production build completes successfully

- [ ] **Step 2: Run fixed-profile smoke validation**

Run:

```bash
pnpm probe:tm
```

Expected:

- no freshness failure
- smoke path still works with preview interception code present

- [ ] **Step 3: Run real-page validation on Gemini**

Manual flow:

```bash
pnpm probe:tm:profile
```

Then on `https://gemini.google.com/app` verify:

- preview images reach ready state without needing DOM overlay fallback
- console still reaches `[Gemini Watermark Remover] Initializing...` and `[Gemini Watermark Remover] Ready`
- `复制图片` still writes a de-watermarked `image/png`
- `下载完整尺寸的图片` still uses native chain and remains de-watermarked
- no unexpected `无法获取原图，请刷新页面后重试` alert on healthy flows

- [ ] **Step 4: Capture the final implementation checkpoint**

```bash
git add src/userscript/index.js src/userscript/downloadHook.js src/shared/imageSessionStore.js src/shared/pageImageReplacement.js tests/userscript/downloadHook.test.js tests/userscript/downloadOnlyEntry.test.js tests/shared/imageSessionStore.test.js tests/shared/pageImageReplacement.test.js docs/superpowers/plans/2026-04-05-phase-2-preview-request-layer.md
git commit -m "feat: move Gemini preview processing to request layer"
```

## Self-Review

- Spec coverage:
  - preview `gg` request-layer interception: covered by Tasks 1-3
  - unified display/copy/download pipeline direction: covered by Tasks 2-4
  - retire or demote `pageImageReplacement.js`: covered by Task 5
  - build and fixed-profile validation: covered by Task 6
- Placeholder scan:
  - no `TODO` or deferred placeholders remain in the task steps
  - each task names exact files, commands, and expected effects
- Type consistency:
  - the plan consistently uses `createGeminiDownloadFetchHook(...)` as the shared response-transform helper
  - `preview` and `full` remain the only processed slots in the session store

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-05-phase-2-preview-request-layer.md`. Two execution options:

1. Subagent-Driven (recommended) - I dispatch a fresh subagent per task, review between tasks, fast iteration

2. Inline Execution - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
