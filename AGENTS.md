# AGENTS.md

## Debug Workflow

### Fixed Tampermonkey / Gemini Environment

- Fixed Chrome profile: `D:\Project\gemini-watermark-remover\.chrome-debug\tampermonkey-profile`
- Fixed CDP port: `9226`
- Default proxy: `http://127.0.0.1:7890`
- Production userscript artifact: `dist/userscript/gemini-watermark-remover.user.js`

### Open the Fixed Profile

- PowerShell launcher: `.\open-fixed-chrome-profile.ps1`
- Node launcher: `node scripts/open-tampermonkey-profile.js --cdp-port 9226`

Default behavior:

- Reuse the fixed Chrome profile
- Open remote debugging on port `9226`
- Use the local proxy
- Open the local probe page by default, or a passed target URL

### One-Time Manual Setup

Do this only once in the fixed profile:

1. Install Tampermonkey.
2. Enable `Allow User Scripts` in Chrome extension details.
3. Keep Developer Mode enabled.
4. Install `public/tampermonkey-worker-probe.user.js` when local probe validation is needed.
5. Install or reinstall the production userscript from `http://127.0.0.1:4173/userscript/gemini-watermark-remover.user.js` when validating the latest build.

### Local Build and Services

- Production build: `pnpm build`
- Local dist server: dev mode or an existing `http://127.0.0.1:4173/`
- Probe smoke test: `pnpm probe:tm`
- Open fixed profile: `pnpm probe:tm:profile`

### Real Gemini Page Validation

Target page:

- `https://gemini.google.com/app`

Minimum validation flow:

1. Run `pnpm build`
2. Reinstall the latest userscript in the fixed profile
3. Open the real Gemini page
4. Check that the console shows:
   - `[Gemini Watermark Remover] Initializing...`
   - `[Gemini Watermark Remover] Ready`
5. If bridge validation is needed, trigger from page side:
   - `gwr:userscript-process-request`
   - Expect `gwr:userscript-process-response`

### Real-Page Pixel Verification

- Single image compare: `pnpm probe:real-page:compare`
- All ready images on the current Gemini page: `pnpm probe:real-page:compare --all`
- Latest batch summary:
  - `.artifacts/real-page-pixel-compare/latest-summary.json`

Use this when page-level screenshots are not enough and you need original blob pixel metrics for `before/after`.

Current confirmed real-page batch baseline on the fixed profile:

- 5 preview images reached `state=ready`
- Easier samples currently land around:
  - `afterSpatial ~= 0.017 ~ 0.040`
  - `afterGradient ~= 0.075 ~ 0.098`
- Stronger watermark samples currently land around:
  - `afterSpatial ~= 0.133 ~ 0.155`
  - `afterGradient ~= 0.295 ~ 0.304`

These stronger-sample numbers are intentional tradeoffs after edge cleanup:

- They are much better than the older `afterGradient ~= 0.53` level.
- They keep residuals inside the current safety envelope instead of risking content damage.

### Confirmed Performance Pitfalls

When the user reports "this version became much slower", check these first before touching the core algorithm:

1. Page runtime / page bridge did not actually install into the real Gemini page.
   - Symptom:
     - Real page silently falls back to the userscript sandbox / slow main-thread path.
     - Earlier bad runs showed `removeWatermarkMs` on the order of `11s ~ 13s` for a single preview image.
   - Verify:
     - Reinstall the latest userscript from `http://127.0.0.1:4173/userscript/gemini-watermark-remover.user.js`
     - Refresh the real page
     - Confirm console reaches `Initializing...` and `Ready`
     - Confirm preview images continue to `page image process success`

2. Preview queue blocked by a `blob:` image that is not renderable yet.
   - Symptom:
     - One image gets stuck at `state=processing`
     - The element often has `complete=false`, `naturalWidth=0`, `naturalHeight=0`
     - Later images stop progressing because the serial queue is effectively wedged
   - Current fix:
     - `src/shared/pageImageReplacement.js` now waits for renderability and retries instead of processing immediately
   - If this regresses, inspect the waiting / retry path before changing watermark math

3. `preview-fast` accidentally doing expensive work that is not adopted.
   - Symptom:
     - Main thread is busy, but output source does not include a successful `+subpixel`
     - Earlier bad runs showed `subpixelRefinementMs ~= 80ms ~ 115ms` on strong preview samples with no accepted subpixel shift
   - Current fix:
     - `preview-fast` no longer runs the expensive subpixel refinement path
     - It relies on cheaper preview edge cleanup instead
   - Rule:
     - Do not re-enable preview-fast subpixel search unless you have a real fixture that proves the accepted result is both safer and materially better

### Confirmed Quality / Performance Tradeoff

For strong real-page preview samples, the current strategy is:

- Skip expensive preview-fast subpixel refinement
- Use stronger preview edge cleanup only when:
  - the image is a preview-anchor style match
  - spatial residual is already low enough to be safe
  - gradient residual is still strong enough to justify cleanup

Why this exists:

- It lowers strong-sample real-page residual gradient from roughly `0.53` to roughly `0.30`
- It keeps preview-fast latency low by avoiding no-op subpixel sweeps
- It accepts some spatial drift to stay within a safe residual envelope rather than overfitting and risking content damage

### Worker Debug Flow

For reproduction only. This is not the default production path.

1. In the real page DevTools, run:
   - `localStorage.setItem('__gwr_force_inline_worker__', '1')`
2. Refresh `https://gemini.google.com/app/...`
3. Inspect console logs

Current confirmed result:

- The real Gemini page can attempt to start the inline worker.
- The worker crashes during startup because of CSP / runtime restrictions.
- Production must stay on the main-thread path by default.
- The force flag is for debugging only.

### Worker Success / Failure Criteria

Do not treat `new Worker(blobUrl)` returning without an immediate throw as proof that the worker is usable.

Current correct criteria:

- If `[Gemini Watermark Remover] Worker acceleration enabled` appears, that only means startup was attempted.
- The worker is only considered usable if the startup handshake succeeds.
- If `[Gemini Watermark Remover] Worker initialization failed, using main thread: ...` appears, safe fallback has happened.
- After fallback, the page should still continue with:
  - `page image process start`
  - `page image process strategy`
  - `page image process success`

### Known Constraints

- Direct `new Worker(blobUrl)` from Tampermonkey DOM sandbox is not reliable in the current environment.
- The real Gemini page has CSP restrictions, so worker assumptions must not be based on probe-page success.
- Runtime flags must be read across `unsafeWindow`; reading only the userscript sandbox `globalThis/localStorage` is insufficient.
