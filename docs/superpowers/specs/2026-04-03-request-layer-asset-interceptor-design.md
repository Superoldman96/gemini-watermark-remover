# Request-Layer Asset Interceptor Design

**Date:** 2026-04-03

**Goal:** Replace the current preview-heavy, fail-open userscript flow with a request-layer architecture that is driven by Gemini's generated-asset fetches and fails explicitly when the original asset path is unavailable.

## Problem Summary

The current userscript mixes three different control planes:

- request interception for download/original assets
- clipboard interception for copy
- DOM-driven preview replacement

That creates two classes of bugs:

- multiple paths can produce different source images for the same user action
- failures often degrade silently to "looks successful, still watermarked"

The real issue is not the watermark engine itself. Local Node processing on `src/assets/samples/debug1.png` remains stable. The instability is in the browser orchestration layer.

## Real-Page Findings

Real-page debugging was performed against:

- `https://gemini.google.com/u/1/app/d3cd7d14852ecd3b?pageId=none`
- fixed debug profile on CDP `9226`

Observed facts:

1. The displayed generated images do not stay on a stable original URL.
   - On the real page, generated image elements end up at `blob:` URLs.
   - The current DOM replacement path writes `data-gwr-page-image-state=ready` and `data-gwr-watermark-object-url=blob:...`.

2. Those `blob:` display URLs are not the source of truth.
   - On page reload, Gemini fetches generated assets through page script `fetch`, mostly to `lh3.googleusercontent.com/gg/...` and `lh3.googleusercontent.com/rd-gg/...`.
   - The fetched responses are then materialized into page `blob:` URLs for display.

3. Copy is also request-driven in practice.
   - Clicking `复制图片` triggered:
     - one Gemini RPC (`ESY5D`)
     - preview fetches on `gg/...`
     - original/full-quality fetches on `rd-gg/...`
     - a final `navigator.clipboard.write(...)`
   - The clipboard payload written by Gemini was `image/png`, about `950617` bytes, and decoded to `1568 x 672`.
   - This means copy is not a simple "copy the currently displayed DOM image" path.

4. Download is also request-driven, but more fragile under automation.
   - Clicking `下载完整尺寸的图片` triggered Gemini RPC `c8o8Fe`.
   - On the fixed-profile trace captured on 2026-04-04:
     - `c8o8Fe` request started about `+50ms` after click
     - `c8o8Fe` response returned about `+22.4s`
     - `gg-dl` and `work.fife ... rd-gg-dl` hops both returned `text/plain`
     - the final `lh3.googleusercontent.com/rd-gg-dl/...=s0-d-I` returned `image/png` at about `+23.9s`
   - The browser then saved a full-size `3136 x 1344` PNG through a blob-backed download event.
   - Local detector analysis on that saved PNG reported `skipReason=no-watermark-detected`.

## Root Cause

The current architecture is too permissive:

- preview and full/original assets are treated as interchangeable too early
- session resource lookup is "best available" instead of action-specific
- clipboard and download hooks both silently fall back on failure
- preview replacement keeps a separate DOM-first processing lane alive even when request-derived data exists

This is why the system can appear "ready" while still preserving watermark artifacts.

There is also a more specific download regression to avoid:

- an active userscript-side direct-download click hook that cancels Gemini's native button event too early
- this blocks Gemini's own `c8o8Fe` and `rd-gg-dl` chain before the stable full-quality path is available
- once that happens, the userscript only sees earlier `hNvQHb` history bindings, which currently resolve mostly to preview-style `gg/...=s0` URLs
- using those preview bindings as the direct download source recreates the original instability:
  - missing-original failures
  - cross-context fetch failures
  - false confidence that the action is "handled" while the real native path never ran

There is one more root-cause detail for the passive path:

- the old base intent window was only `5000ms`
- real Gemini full-size download chains can take `20s+` before the final `rd-gg-dl image/png` request appears
- when that happens, the passive request-layer hook misses the request even though the architecture is otherwise correct
- the fix is not to reintroduce an active click-cancel path; it is to keep an explicit download intent sticky for Gemini download asset URLs long enough to cover the native chain

## Final Direction

The stable direction is a request-layer interceptor, not a DOM replacement system.

### Phase 1

Ship a fail-closed request-driven path for explicit actions:

- keep original-asset discovery from RPC/history parsing
- intercept Gemini `rd-gg` / `rd-gg-dl` original/full-quality fetch responses
- process the intercepted response body before it reaches Gemini's own copy/download flow
- disable default DOM preview replacement
- keep the click layer passive:
  - arm copy/download intent
  - keep explicit download intent sticky for late Gemini download asset requests
  - do not cancel Gemini's native button handling just to start a parallel userscript-only download flow
- if original binding/full-quality asset resolution is unavailable, show an explicit user-facing error:
  - `无法获取原图，请刷新页面后重试`

What this buys:

- copy and download both converge on the same original-quality processing path
- no more preview/rendered-capture fallback pretending to be success
- page-level DOM mutation stops being the primary correctness mechanism

### Phase 2

Extend the same request-layer interceptor to Gemini `gg` preview fetches:

- process preview fetch responses at the network/request layer
- let Gemini continue rendering its own `blob:` display images, now already de-watermarked
- remove or retire the remaining need for `src/shared/pageImageReplacement.js`

This is the path that can eventually unify display, copy, and download under one response-transform pipeline.

## Explicit Non-Goals For Phase 1

- no new idle-time DOM replacement system
- no preview `blob:` capture path
- no rendered-canvas fallback as a success path
- no silent fallback to original/watermarked clipboard or download output

## Architectural Shape

Phase 1 should converge toward these responsibilities:

- `historyBindingBootstrap` and RPC parsing:
  - discover `assetIds -> original/full-quality URL` bindings
- request-layer generated-asset hook:
  - decide whether a request is Gemini generated media
  - normalize URL
  - process intercepted response body
  - cache in-flight work by normalized asset URL
- action-specific failure surface:
  - copy/download remain user-visible actions
  - if a required full/original path cannot be resolved, stop and notify
- session store:
  - store processed full-quality results separately from any preview/display state
  - stop returning preview results as a "best resource" for copy/download correctness

## Why This Is Better Than The Current DOM Path

- It matches Gemini's real behavior more closely.
- It removes duplicated image-source decision logic from the page layer.
- It lets Gemini keep its own rendering/clipboard/download UX while the userscript only transforms bytes in transit.
- It makes failures detectable and explicit instead of visual guesswork.

## Risks

- Some generated media may still arrive through native image loading rather than page `fetch` in future Gemini builds.
- Copy and download may not stay identical forever; request signatures should be logged and asserted in tests.
- Request interception must install early enough during userscript startup to avoid missing first-load assets.

## Verification Requirements

Minimum verification for Phase 1:

- unit tests for request interception and fail-closed behavior
- unit tests proving copy/download no longer reuse preview resources as success paths
- startup/entry tests proving preview DOM replacement is not installed by default
- real-page validation on fixed profile:
  - request logs show the native `c8o8Fe -> gg-dl -> rd-gg-dl` chain and late `image/png` interception on download
  - clipboard output is de-watermarked
  - downloaded full-size PNG is de-watermarked
  - binding failure surfaces the explicit refresh/retry error

## Decision

Proceed on a new branch with Phase 1 first:

- request-layer original/full-quality interception for copy/download
- preview DOM replacement disabled by default
- explicit user-visible failure when the required original path cannot be resolved

Phase 2 stays planned but separate:

- request-layer preview interception for `gg` display assets
