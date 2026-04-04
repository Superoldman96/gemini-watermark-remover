# AGENTS.md

## Debug Workflow

### Fixed Tampermonkey / Gemini Environment

- Fixed Chrome profile: `.chrome-debug/tampermonkey-profile`
- Fixed CDP port: `9226`
- Default proxy: `http://127.0.0.1:7890`
- Production userscript artifact: `dist/userscript/gemini-watermark-remover.user.js`

### Open the Fixed Profile

- CMD launcher: `.\scripts\open-fixed-chrome-profile.cmd`
- PowerShell launcher: `.\scripts\open-fixed-chrome-profile.ps1`
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
5. Install or reinstall the production userscript from the current local build server when validating the latest build.
   - Preferred current dev URL: `http://127.0.0.1:4317/userscript/gemini-watermark-remover.user.js`
   - Do not assume `4173` is current if another static server is already running there.

### Local Build and Services

- Production build: `pnpm build`
- Local dist server: dev mode or the active local build server for this worktree
- Current confirmed dev server during request-layer debugging: `http://127.0.0.1:4317/`
- Probe smoke test: `pnpm probe:tm`
- Open fixed profile: `pnpm probe:tm:profile`

### Installed Userscript Freshness Check

When real-page behavior does not match the current worktree, verify the installed userscript body, not just the script name or `@version`.

- Same `@version` does not guarantee the fixed profile is running the latest build.
- A stale Tampermonkey script can still show:
  - `[Gemini Watermark Remover] Initializing...`
  - `[Gemini Watermark Remover] Ready`
  - while silently missing newer request-layer fixes such as the download sticky intent window
- If the real page shows old behavior after a reinstall:
  1. Open the Tampermonkey editor for `Gemini NanoBanana 图片水印移除`
  2. Compare the installed source against `dist/userscript/gemini-watermark-remover.user.js`
  3. Confirm the installed source contains the expected newer markers before continuing real-page debugging
     - `DEFAULT_DOWNLOAD_STICKY_WINDOW_MS`
     - `downloadStickyUntil`
     - `getActionContextFromIntentGate(intentGate = null, candidate = null)`
  4. Refresh the real Gemini page after the fixed profile is updated

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

Current confirmed request-layer behavior on the fixed profile:

- `copy` can populate the strict original binding path through real `rd-gg` asset fetches and then place a processed `image/png` onto the clipboard
- `download` stays on Gemini's native `c8o8Fe -> gg-dl -> rd-gg-dl` export flow; the userscript does not cancel the click
- the userscript keeps explicit download intent alive for Gemini download asset URLs long enough to catch late `rd-gg-dl` requests on the native chain
- If the original URL binding is unavailable when the required download/original request arrives, the action must fail closed with:
  - `无法获取原图，请刷新页面后重试`
- A successful real-page full-size download currently produces:
  - a browser `download` event
  - a blob-backed saved file such as `Gemini_Generated_Image_vusbaevusbaevusb.png`
  - local detector result `skipReason=no-watermark-detected`

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
     - Reinstall the latest userscript from the current active build server
       - current confirmed URL: `http://127.0.0.1:4317/userscript/gemini-watermark-remover.user.js`
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

3. Preview-anchor cleanup accidentally doing expensive work that is not adopted.
   - Symptom:
     - Main thread is busy, but output source does not include a successful `+subpixel`
     - Earlier bad runs showed `subpixelRefinementMs ~= 80ms ~ 115ms` on strong preview samples with no accepted subpixel shift
   - Current fix:
     - preview-anchor cleanup no longer runs the expensive subpixel refinement path
     - It relies on cheaper preview edge cleanup instead
   - Rule:
     - Do not re-enable preview-anchor subpixel search unless you have a real fixture that proves the accepted result is both safer and materially better

### Confirmed Quality / Performance Tradeoff

For strong real-page preview samples, the current strategy is:

- Skip expensive preview-anchor subpixel refinement
- Use stronger preview edge cleanup only when:
  - the image is a preview-anchor style match
  - spatial residual is already low enough to be safe
  - gradient residual is still strong enough to justify cleanup

Why this exists:

- It lowers strong-sample real-page residual gradient from roughly `0.53` to roughly `0.30`
- It keeps preview-anchor cleanup latency low by avoiding no-op subpixel sweeps
- It accepts some spatial drift to stay within a safe residual envelope rather than overfitting and risking content damage

### Confirmed Download / Copy Integration Constraint

Do not re-enable the old active direct-download click hook in production.

Confirmed real-page failure mode on `https://gemini.google.com/u/1/app/d3cd7d14852ecd3b?pageId=none`:

- When the userscript intercepts `下载完整尺寸的图片` at capture time and calls `preventDefault()/stopImmediatePropagation()`, Gemini's own download flow is blocked before it can issue its native `c8o8Fe` / `rd-gg-dl` chain.
- In that state, the userscript only has the earlier history bootstrap bindings from `hNvQHb`.
- Current real `hNvQHb` bindings are mostly preview-style `gg/...=s0` URLs, not the final native download URL.
- Falling back to those preview bindings makes the userscript attempt its own fetch path too early, which previously surfaced as:
  - `Original image is unavailable for download processing`
  - or `Failed to fetch image: 403`
  - followed by the user-facing retry alert

There is a second real-page failure mode to keep in mind even after removing the active click hook:

- Gemini's native full-size download chain can be much slower than the base intent window.
- On the 2026-04-04 fixed-profile trace:
  - `c8o8Fe` request started about `+50ms` after click
  - `c8o8Fe` response returned about `+22.4s`
  - final `rd-gg-dl ... image/png` arrived about `+23.9s`
- A plain `5000ms` intent window expires far too early, so the passive request hook stops processing before the final full-size image request appears.

Current correct production shape:

- keep the intent gate for copy / download gestures
- keep Gemini RPC discovery hooks (`hNvQHb`, `c8o8Fe`, related batchexecute responses)
- keep generated-asset fetch interception for the native request flow
- let Gemini continue its own click handling
- do not block the button just to start a parallel userscript-only download path
- keep a download-specific sticky intent window for Gemini download asset URLs
  - current default: `30000ms`
  - release it after terminal success/failure so it does not leak across actions

Current confirmed real-page result with the passive native chain plus sticky download intent:

- `下载完整尺寸的图片` produced a browser `download` event
- the resulting download used a blob URL generated from the page flow
- the saved file was `3136 x 1344`, about `5.4MB`, sha256 `4e945813779b58a5eda0f01f7973c924210477a84ae1d3826138f57b60eb691f`
- local detector on that downloaded file reported:
  - `skipReason = no-watermark-detected`
  - `originalSpatialScore ~= -0.4096`
  - `originalGradientScore ~= 0.0826`
- no `无法获取原图，请刷新页面后重试` alert appeared
- `复制图片` wrote an `image/png` item to the clipboard without a failure alert
- current artifact:
  - `.artifacts/request-layer-effect-verify/2026-04-04T15-00-44-510Z/download/report.json`

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
