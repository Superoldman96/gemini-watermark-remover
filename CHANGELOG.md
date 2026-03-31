# Changelog

## 1.0.7 - 2026-03-31

### Userscript

- Improved watermark anchor recovery for near-official portrait outputs and preview-sized Gemini images that drift away from the default anchor.
- Stopped harmful extra removal passes earlier when the first pass already clears the watermark-shaped residual well enough.
- Kept preview-anchor cleanup on the cheaper edge-cleanup path instead of reintroducing expensive no-op subpixel sweeps.

### Quality

- Added regression coverage for anchor recovery, pass stopping, and release metadata consistency.
- Added the single-pass versus multipass tradeoff note used during this release cycle.

## 1.0.6 - 2026-03-30

### Userscript

- Unified Gemini preview, fullscreen, clipboard, and download actions around a shared image-session and `actionContext` pipeline.
- Reused processed session resources across surfaces so fullscreen copy/download can resolve the same processed image identity more reliably.
- Removed deprecated userscript legacy intent aliases from the active runtime path to simplify release behavior before shipping.

### Quality

- Added focused coverage for `actionContext`, shared image-session resolution, and userscript hook behavior after the release cleanup.
- Re-verified the release with a fresh full test run and production build.

## 1.0.2 - 2026-03-20

### Userscript

- Simplified Gemini page-image replacement into smaller shared helpers for processing preparation, mutation routing, source dispatch, and result application.
- Simplified Gemini original-blob acquisition so preview urls use rendered capture, download urls use background fetch, and inline urls stay on direct fetch.
- Simplified Gemini download interception to keep only in-flight request deduplication instead of retaining processed response cache entries.

### Quality

- Added focused regression coverage for preview/original source dispatch, candidate image collection, mutation scheduling, and self-written processed blob detection.
- Re-verified the release with full automated tests and a fresh production build.

## 1.0.1 - 2026-03-19

### Userscript

- Added in-page Gemini preview replacement so page images can be processed before manual download.
- Routed preview fetching through `GM_xmlhttpRequest` when available, avoiding fallback CORS failures in userscript sandboxes.
- Added a restrained `Processing...` overlay during preview processing and made failures fail-open so the original image remains visible.
- Hardened overlay lifecycle cleanup to avoid stale fade callbacks removing a new processing state.

### Extension

- Kept page-image replacement behavior aligned with the userscript preview pipeline and processing-state UX.

### Quality

- Added regression tests for userscript version sync and processing overlay lifecycle edge cases.
- Verified release build with full automated test coverage and production bundle generation.
