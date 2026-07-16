# Scoped Release Quality Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the global historical-artifact release blocker with a fail-closed `image-defaults` gate backed by pinned v1.0.30 image evidence, while keeping broad V2 and video claims blocked without their own evidence.

**Architecture:** A small image-evidence core normalizes the real 36/424/manual-review reports, pins source and release-package hashes, and validates them without depending on ignored historical video artifacts. Release readiness consumes that verified evidence under an explicit `image-defaults` scope; Allenk/V2 remains a claim-status report, and video production changes remain out-of-scope blockers.

**Tech Stack:** JavaScript ES modules, Node.js `node:test`, Node.js crypto/fs/child_process, pnpm, existing release-readiness and goal-audit scripts.

## Global Constraints

- Keep package version exactly `1.0.30`.
- Use `pnpm`, never `npm` or `npx`.
- Do not start `pnpm dev`, `pnpm serve`, or any local application server.
- Do not modify image selection, restoration, alpha, or repair behavior in this plan.
- `image-defaults` may publish current image behavior only; broad image V2 coverage and video V2 Allenk parity remain forbidden claims.
- Video denoise and video alpha-shape candidates remain experiment-only and must not become production defaults.
- Any change under `src/video/` or `src/video-app.js` relative to tag `v1.0.29` blocks this scoped release.
- Missing, malformed, stale, or hash-mismatched image evidence fails closed.
- Preserve build, full test, SDK smoke, extension package, current-HEAD GitHub CI, and release-package checksum gates.
- Generate fixed evidence only from real `.artifacts` reports; do not reconstruct metrics from docs or changelogs.
- Preserve unrelated user changes in the dirty worktree and stage only files listed by each task.

---

## File Structure

- Create `scripts/image-release-evidence.js`: pure normalization, comparison, hashing, and validation functions.
- Create `scripts/run-image-release-validation.js`: run full test, SDK smoke, build, and extension packaging and write machine-readable command results.
- Create `scripts/create-image-release-evidence.js`: CLI that reads real validation reports and writes the pinned evidence JSON.
- Create `scripts/check-image-release-evidence.js`: CLI that verifies pinned evidence and rejects out-of-scope video changes.
- Create `tests/scripts/imageReleaseEvidence.test.js`: unit and CLI coverage for evidence generation and verification.
- Create `release/evidence/v1.0.30-image-quality.json`: compact, committed evidence derived from the current real reports.
- Modify `scripts/create-release-readiness-report.js`: add explicit scope and the image-evidence lane.
- Modify `tests/scripts/releaseReadinessReport.test.js`: scope/readiness/claim regression coverage.
- Modify `scripts/create-release-goal-audit-report.js`: make verified image evidence, rather than complete Allenk history, the scoped RC objective.
- Modify `tests/scripts/releaseGoalAuditReport.test.js`: updated objective and fail-closed coverage.
- Modify `package.json`, `tests/scripts/scriptEntrypoints.test.js`, and `tests/project/releaseMetadata.test.js`: exact script contracts.
- Modify `RELEASE.md` and `RELEASE_zh.md`: explain scoped capability and claim gates.

---

### Task 1: Pure Image Release Evidence Contract

**Files:**
- Create: `scripts/image-release-evidence.js`
- Create: `tests/scripts/imageReleaseEvidence.test.js`

**Interfaces:**
- Consumes: parsed JSON for contrast, curated-before, curated-after, exact-96 manual report/decisions, automated validation, package metadata, and release metadata.
- Produces: `buildImageReleaseEvidence(inputs) -> evidence`, `summarizeExact96Review(report, decisions) -> summary`, `verifyImageReleaseEvidence(evidence, current) -> { ok, blockers }`, `sha256File(path) -> Promise<string>`, and `IMAGE_RELEASE_SOURCE_PATHS`.

- [ ] **Step 1: Write failing normalization and comparison tests**

Add fixtures directly in `tests/scripts/imageReleaseEvidence.test.js` and assert the exact v1.0.30 contract:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildImageReleaseEvidence,
    compareCuratedReports,
    verifyImageReleaseEvidence
} from '../../scripts/image-release-evidence.js';

function curatedResult(fileName, {
    candidateId,
    qualityStatus = 'clean',
    position = { x: 100, y: 100, width: 96, height: 96 },
    retryRecommended = false,
    catastrophicBlock = false
}) {
    return {
        fileName,
        selectedCandidate: { id: candidateId, position },
        position,
        qualityStatus,
        retryRecommended,
        catastrophicBlock
    };
}

test('compareCuratedReports counts candidate changes without accepting position or status drift', () => {
    const before = {
        summary: { count: 2, errors: 0, retryRecommended: 0, catastrophicBlocks: 0 },
        results: [
            curatedResult('a.png', { candidateId: 'old-a' }),
            curatedResult('b.png', { candidateId: 'same-b' })
        ]
    };
    const after = {
        summary: { count: 2, errors: 0, retryRecommended: 0, catastrophicBlocks: 0 },
        results: [
            curatedResult('a.png', { candidateId: 'new-a' }),
            curatedResult('b.png', { candidateId: 'same-b' })
        ]
    };

    assert.deepEqual(compareCuratedReports(before, after, ['a.png']), {
        total: 2,
        candidateChangeCount: 1,
        changedFileNames: ['a.png'],
        outOfScopeChangeCount: 0,
        positionChangeCount: 0,
        qualityStatusChangeCount: 0,
        missingBeforeCount: 0,
        missingAfterCount: 0
    });
});

test('buildImageReleaseEvidence keeps only exact-96 manual verdicts', async () => {
    const evidence = await buildImageReleaseEvidence({
        version: '1.0.30',
        generatedAt: '2026-07-16T00:00:00.000Z',
        contrast: {
            summary: {
                total: 36,
                catastrophicBlocks: 0,
                recoveredClean: 15,
                recoveredCleanTotal: 16,
                qualityStatuses: { clean: 19, 'visible-residual': 15, 'possible-content-damage': 2 }
            }
        },
        curatedBefore: { summary: { count: 1 }, results: [curatedResult('a.png', { candidateId: 'old' })] },
        curatedAfter: {
            summary: { count: 1, errors: 0, retryRecommended: 0, catastrophicBlocks: 0 },
            results: [curatedResult('a.png', { candidateId: 'new' })]
        },
        manualReview: {
            exact96: { alternativeBetter: 7, tie: 3, currentBetter: 0, unclear: 0 },
            fileNames: ['a.png']
        },
        automated: {
            fullTest: { ok: true, passed: 1316, skipped: 28, failed: 0 },
            sdkSmoke: { ok: true, passed: 8, skipped: 0, failed: 0 },
            build: { ok: true },
            extensionPackage: { ok: true }
        },
        provenance: { sourceFiles: [], inputArtifacts: [] },
        releasePackage: { version: '1.0.30', file: 'x.zip', sha256: 'a'.repeat(64), size: 123 }
    });

    assert.deepEqual(evidence.validation.manualExact96, {
        total: 10,
        alternativeBetter: 7,
        tie: 3,
        currentBetter: 0,
        unclear: 0
    });
    assert.equal(evidence.validation.curated.candidateChangeCount, 1);
});

test('verifyImageReleaseEvidence fails closed on stale source hashes and unsafe metrics', () => {
    const evidence = {
        schemaVersion: 1,
        releaseScope: 'image-defaults',
        version: '1.0.30',
        provenance: {
            sourceFiles: [{ path: 'src/core/example.js', sha256: 'a'.repeat(64) }]
        },
        validation: {
            contrast: { total: 36, catastrophicBlocks: 0, retryRecommended: 0, recoveredClean: 15, recoveredCleanTotal: 16 },
            curated: {
                total: 424,
                errors: 0,
                catastrophicBlocks: 0,
                retryRecommended: 0,
                positionChangeCount: 0,
                qualityStatusChangeCount: 0,
                outOfScopeChangeCount: 0
            },
            manualExact96: { total: 10, alternativeBetter: 7, tie: 3, currentBetter: 0, unclear: 0 },
            automated: {
                fullTest: { ok: true, failed: 0 },
                sdkSmoke: { ok: true, failed: 0 },
                build: { ok: true },
                extensionPackage: { ok: true }
            }
        },
        releasePackage: { version: '1.0.30', sha256: 'b'.repeat(64), size: 123 }
    };

    const result = verifyImageReleaseEvidence(evidence, {
        version: '1.0.30',
        sourceHashes: new Map([['src/core/example.js', 'c'.repeat(64)]]),
        releasePackage: { version: '1.0.30', sha256: 'b'.repeat(64), size: 123 },
        outOfScopeChangedFiles: []
    });

    assert.equal(result.ok, false);
    assert.ok(result.blockers.includes('image-evidence-source-hash-mismatch:src/core/example.js'));
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
node --test tests/scripts/imageReleaseEvidence.test.js
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `scripts/image-release-evidence.js`.

- [ ] **Step 3: Implement the pure contract**

Create `scripts/image-release-evidence.js` with these exact exports and blocker rules:

```js
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export const IMAGE_RELEASE_SOURCE_PATHS = Object.freeze([
    'src/core/adaptiveDetector.js',
    'src/core/candidateEvaluation.js',
    'src/core/candidateSelector.js',
    'src/core/darkOutlineContourRepair.js',
    'src/core/embeddedAlphaMaps.js',
    'src/core/embeddedDarkOutlineAlphaMap.js',
    'src/core/embeddedOutlineAlphaMap.js',
    'src/core/imageWatermarkPipeline.js',
    'src/core/pipelineAcceptedExecutor.js',
    'src/core/pipelineCandidatePool.js',
    'src/core/pipelineCandidateQuality.js',
    'src/core/pipelineCandidateRunner.js',
    'src/core/pipelineFinalization.js',
    'src/core/pipelineInitialSelection.js',
    'src/core/pipelineMeta.js',
    'src/core/pipelineRepairGates.js',
    'src/core/pipelineRepairStageSpecs.js',
    'src/core/pipelineResult.js',
    'src/core/restorationMetrics.js',
    'src/core/watermarkEngine.js',
    'src/core/watermarkProcessor.js',
    'src/sdk/image-data.js'
]);

export async function sha256File(filePath) {
    const value = await readFile(filePath);
    return createHash('sha256').update(value).digest('hex');
}

function stablePosition(value) {
    const position = value?.selectedCandidate?.position || value?.position || null;
    return position
        ? `${position.x}:${position.y}:${position.width}:${position.height}`
        : null;
}

export function compareCuratedReports(before, after, allowedCandidateChanges = []) {
    const beforeByName = new Map((before?.results || []).map((item) => [item.fileName, item]));
    const afterByName = new Map((after?.results || []).map((item) => [item.fileName, item]));
    const names = [...new Set([...beforeByName.keys(), ...afterByName.keys()])].sort();
    const changedFileNames = [];
    let positionChangeCount = 0;
    let qualityStatusChangeCount = 0;
    let missingBeforeCount = 0;
    let missingAfterCount = 0;

    for (const name of names) {
        const left = beforeByName.get(name);
        const right = afterByName.get(name);
        if (!left) { missingBeforeCount++; continue; }
        if (!right) { missingAfterCount++; continue; }
        if (left.selectedCandidate?.id !== right.selectedCandidate?.id) changedFileNames.push(name);
        if (stablePosition(left) !== stablePosition(right)) positionChangeCount++;
        if (left.qualityStatus !== right.qualityStatus) qualityStatusChangeCount++;
    }

    return {
        total: after?.summary?.count ?? after?.results?.length ?? 0,
        candidateChangeCount: changedFileNames.length,
        changedFileNames,
        outOfScopeChangeCount: changedFileNames.filter((name) => !allowedCandidateChanges.includes(name)).length,
        positionChangeCount,
        qualityStatusChangeCount,
        missingBeforeCount,
        missingAfterCount
    };
}
```

In the same file, implement `summarizeExact96Review(report, decisions)` by joining `report.records` and `decisions.decisions` on `fileName`, keeping only `record.status === 'matched'` and `record.selected.position.width === 96 && height === 96`, and returning the four verdict counts plus sorted file names. Implement `buildImageReleaseEvidence` so it normalizes the contrast summary, calls `compareCuratedReports(curatedBefore, curatedAfter, manualReview.fileNames)`, stores `manualReview.exact96`, and records the supplied provenance/automated/release package data. Derive contrast retry count from `contrast.results.filter(item => item.retryRecommended).length`; retain `summary.recoveredClean` and `summary.recoveredCleanTotal` as the former-clean recovery boundary. Implement `verifyImageReleaseEvidence` with these exact blockers:

```js
const blockers = [];
if (evidence?.schemaVersion !== 1) blockers.push('image-evidence-schema-unsupported');
if (evidence?.releaseScope !== 'image-defaults') blockers.push('image-evidence-scope-mismatch');
if (evidence?.version !== current.version) blockers.push('image-evidence-version-mismatch');
if (evidence?.validation?.contrast?.total !== 36) blockers.push('image-evidence-contrast-total-mismatch');
if (evidence?.validation?.contrast?.catastrophicBlocks !== 0) blockers.push('image-evidence-contrast-catastrophic');
if (evidence?.validation?.contrast?.retryRecommended !== 0) blockers.push('image-evidence-contrast-retry');
if (evidence?.validation?.contrast?.recoveredClean < 15 || evidence?.validation?.contrast?.recoveredCleanTotal !== 16) blockers.push('image-evidence-contrast-recovery-regression');
if (evidence?.validation?.curated?.total !== 424) blockers.push('image-evidence-curated-total-mismatch');
if (evidence?.validation?.curated?.candidateChangeCount !== 10) blockers.push('image-evidence-curated-candidate-change-count-mismatch');
for (const key of ['errors', 'catastrophicBlocks', 'retryRecommended', 'positionChangeCount', 'qualityStatusChangeCount', 'outOfScopeChangeCount']) {
    if (evidence?.validation?.curated?.[key] !== 0) blockers.push(`image-evidence-curated-${key}`);
}
const exact96 = evidence?.validation?.manualExact96;
if (exact96?.total !== 10 || exact96?.alternativeBetter !== 7 || exact96?.tie !== 3 || exact96?.currentBetter !== 0 || exact96?.unclear !== 0) {
    blockers.push('image-evidence-manual-exact96-verdict-mismatch');
}
for (const key of ['fullTest', 'sdkSmoke', 'build', 'extensionPackage']) {
    if (evidence?.validation?.automated?.[key]?.ok !== true) blockers.push(`image-evidence-${key}-not-passing`);
}
for (const source of evidence?.provenance?.sourceFiles || []) {
    if (current.sourceHashes.get(source.path) !== source.sha256) {
        blockers.push(`image-evidence-source-hash-mismatch:${source.path}`);
    }
}
if (current.outOfScopeChangedFiles.length > 0) blockers.push('image-evidence-video-scope-changed');
if (evidence?.releasePackage?.version !== current.releasePackage.version) blockers.push('image-evidence-package-version-mismatch');
if (evidence?.releasePackage?.sha256 !== current.releasePackage.sha256) blockers.push('image-evidence-package-hash-mismatch');
if (evidence?.releasePackage?.size !== current.releasePackage.size) blockers.push('image-evidence-package-size-mismatch');
return { ok: blockers.length === 0, blockers };
```

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```powershell
node --test tests/scripts/imageReleaseEvidence.test.js
```

Expected: all image release evidence tests pass.

- [ ] **Step 5: Commit the pure contract**

```powershell
git add scripts/image-release-evidence.js tests/scripts/imageReleaseEvidence.test.js
git commit -m "test: define image release evidence contract"
```

---

### Task 2: Evidence Validation Runner, Generator, and Gate CLIs

**Files:**
- Create: `scripts/run-image-release-validation.js`
- Create: `scripts/create-image-release-evidence.js`
- Create: `scripts/check-image-release-evidence.js`
- Modify: `tests/scripts/imageReleaseEvidence.test.js`

**Interfaces:**
- Consumes: `.artifacts/top-n-candidate-selection/contrast-report.json`, before/after 424 reports, `.artifacts/same-anchor-imperfection-review/report.json`, `.artifacts/same-anchor-imperfection-review/review.json`, current package/release files, and current source files.
- Produces: `.artifacts/release-image-quality/automated-results.json`, `release/evidence/v1.0.30-image-quality.json`, and a CLI exit code that is zero only when evidence is current and no video source changed.

- [ ] **Step 1: Write failing CLI tests**

Extend `tests/scripts/imageReleaseEvidence.test.js` with temporary-project tests that:

```js
test('image release evidence gate rejects video files changed since v1.0.29', async () => {
    const result = verifyImageReleaseEvidence(validEvidence(), {
        version: '1.0.30',
        sourceHashes: validSourceHashes(),
        releasePackage: validReleasePackage(),
        outOfScopeChangedFiles: ['src/video/videoPresetPolicy.js']
    });
    assert.equal(result.ok, false);
    assert.ok(result.blockers.includes('image-evidence-video-scope-changed'));
});

test('validation runner reports command status and node test counts', () => {
    assert.deepEqual(parseNodeTestSummary('# tests 1344\n# pass 1316\n# fail 0\n# skipped 28\n'), {
        total: 1344,
        passed: 1316,
        failed: 0,
        skipped: 28
    });
});
```

Also spawn `check-image-release-evidence.js` against a temporary valid evidence file and a fake `git` runner injection or `--changed-files-json` fixture, asserting exit `0`; change one hash and assert non-zero with the exact blocker in stderr.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
node --test tests/scripts/imageReleaseEvidence.test.js
```

Expected: FAIL because the three CLI modules and `parseNodeTestSummary` do not exist.

- [ ] **Step 3: Implement the automated validation runner**

Create `scripts/run-image-release-validation.js`. Export `parseNodeTestSummary(text)` and run these commands sequentially with `spawnSync`:

```js
const commands = [
    { id: 'fullTest', command: 'pnpm', args: ['test'], parseNodeTests: true },
    { id: 'sdkSmoke', command: 'pnpm', args: ['test:sdk-smoke'], parseNodeTests: true },
    { id: 'build', command: 'pnpm', args: ['build'] },
    { id: 'extensionPackage', command: 'pnpm', args: ['package:extension'] }
];
```

Use `shell: process.platform === 'win32'`, capture stdout/stderr, stop after the first non-zero result, and write:

```json
{
  "generatedAt": "<ISO timestamp>",
  "fullTest": { "ok": true, "total": 1344, "passed": 1316, "failed": 0, "skipped": 28 },
  "sdkSmoke": { "ok": true, "total": 8, "passed": 8, "failed": 0, "skipped": 0 },
  "build": { "ok": true },
  "extensionPackage": { "ok": true }
}
```

The default output is `.artifacts/release-image-quality/automated-results.json`. Exit non-zero when any command fails or test counts cannot be parsed.

- [ ] **Step 4: Implement the evidence generator CLI**

Create `scripts/create-image-release-evidence.js` with defaults:

```js
const DEFAULT_PATHS = Object.freeze({
    contrast: '.artifacts/top-n-candidate-selection/contrast-report.json',
    curatedBefore: '.artifacts/same-anchor-96-imperfection-preference/before-424-report.json',
    curatedAfter: '.artifacts/expanded-sample-validation/curated-top-n/combined-report.json',
    manualReport: '.artifacts/same-anchor-imperfection-review/report.json',
    manualDecisions: '.artifacts/same-anchor-imperfection-review/review.json',
    automated: '.artifacts/release-image-quality/automated-results.json',
    packageJson: 'package.json',
    latestExtension: 'release/latest-extension.json',
    output: 'release/evidence/v1.0.30-image-quality.json'
});
```

Read every input, hash every input artifact and every `IMAGE_RELEASE_SOURCE_PATHS` file, call `summarizeExact96Review(manualReport, manualDecisions)` followed by `buildImageReleaseEvidence`, and write formatted JSON plus newline. Derive zip size/hash from `latest-extension.json` and the actual zip; fail if they disagree. Support explicit `--contrast`, `--curated-before`, `--curated-after`, `--manual-report`, `--manual-decisions`, `--automated`, and `--output` paths for tests.

- [ ] **Step 5: Implement the evidence check CLI**

Create `scripts/check-image-release-evidence.js` and export `checkImageReleaseEvidence(options)`. The function and CLI must:

1. reads package version and `release/evidence/v${version}-image-quality.json`;
2. hashes all evidence source paths;
3. validates zip/checksum/latest metadata;
4. runs `git diff --name-only v1.0.29 -- src/video src/video-app.js`;
5. calls `verifyImageReleaseEvidence`;
6. prints `image release quality gate: pass|fail` and each blocker;
7. exits `1` on any blocker.

Support `--evidence`, `--base-tag`, and `--changed-files-json` so tests never depend on the real repository history.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run:

```powershell
node --test tests/scripts/imageReleaseEvidence.test.js
```

Expected: all pure and CLI tests pass.

- [ ] **Step 7: Commit the executable evidence tooling**

```powershell
git add scripts/run-image-release-validation.js scripts/create-image-release-evidence.js scripts/check-image-release-evidence.js tests/scripts/imageReleaseEvidence.test.js
git commit -m "feat: add scoped image release evidence gate"
```

---

### Task 3: Scoped Release Readiness and Claim Separation

**Files:**
- Modify: `scripts/create-release-readiness-report.js`
- Modify: `tests/scripts/releaseReadinessReport.test.js`

**Interfaces:**
- Consumes: `scope = 'image-defaults'`, verified image evidence, existing release artifacts/claims/userscript/version docs/video-default source checks, and informational Allenk/video lanes.
- Produces: a new `image-release-evidence` lane and a release recommendation that does not require experimental or unclaimed lanes.

- [ ] **Step 1: Write failing scoped-readiness tests**

Add fixtures for a verified image evidence lane and assert:

```js
test('image-defaults scope releases current image defaults while missing historical video evidence remains blocked for claims', async () => {
    const report = await createReleaseReadinessReport({
        scope: 'image-defaults',
        inputs: scopedImageReadyInputs({
            imageEvidenceGate: { ok: true, blockers: [] },
            allenkComparisonEvidenceReady: false,
            videoExperimentEvidenceReady: false
        })
    });

    assert.equal(report.overall.recommendation, 'rc-current-image-defaults-with-scoped-claims');
    assert.equal(report.overall.canReleaseCurrentImageDefaults, true);
    assert.equal(report.overall.canClaimVideoV2Parity, false);
    assert.ok(report.overall.blockedClaims.includes('video-v2-allenk-parity'));
    assert.ok(report.overall.blockedClaims.includes('broad-image-v2-coverage'));
    assert.equal(summarizeReleaseReadinessGate(report).ok, true);
});

test('image-defaults scope fails when pinned image evidence is stale', async () => {
    const report = await createReleaseReadinessReport({
        scope: 'image-defaults',
        inputs: scopedImageReadyInputs({
            imageEvidenceGate: { ok: false, blockers: ['image-evidence-source-hash-mismatch:src/core/example.js'] }
        })
    });
    assert.equal(report.overall.canReleaseCurrentImageDefaults, false);
    assert.equal(summarizeReleaseReadinessGate(report).ok, false);
});
```

Update the package-script fixture to expect:

```js
'release:image-validation': 'node scripts/run-image-release-validation.js',
'release:image-evidence': 'node scripts/create-image-release-evidence.js',
'release:image-quality-gate': 'node scripts/check-image-release-evidence.js',
'release:quality-gate': 'pnpm release:image-quality-gate && pnpm compare:allenk-v2 && pnpm release:readiness -- --scope image-defaults --fail-on-not-ready'
```

- [ ] **Step 2: Run readiness tests and verify RED**

Run:

```powershell
node --test tests/scripts/releaseReadinessReport.test.js
```

Expected: FAIL because `scope` and the image evidence lane are not implemented.

- [ ] **Step 3: Add the image evidence lane**

In `create-release-readiness-report.js`, add default input `imageReleaseEvidence` and a summarizer:

```js
function summarizeImageReleaseEvidence(artifact, gateOverride = null) {
    const gate = gateOverride || artifact.json?.gate || null;
    const blockers = [];
    if (!artifact.exists) blockers.push('image-release-evidence-missing');
    if (gate?.ok !== true) blockers.push(...(gate?.blockers || ['image-release-evidence-not-current']));
    return {
        id: 'image-release-evidence',
        title: 'Image release evidence',
        status: blockers.length === 0 ? 'current' : 'blocked',
        releaseEligible: blockers.length === 0,
        blockers,
        evidence: artifact.json || null
    };
}
```

Allow tests to inject `inputs.imageEvidenceGate`. In production, call the exported `checkImageReleaseEvidence({ writeOutput: false })` so readiness cannot trust an unverified `gate.ok` stored in JSON. Add `imageQuality: { status, gateOk, evidencePath, blockers }` to `releaseEvidenceIndex`, and require its status/gate in index-integrity checks.

- [ ] **Step 4: Make overall readiness scope-aware**

Change `deriveOverall` to accept `scope`. Under `image-defaults`, compute `currentImageCapabilityReady` only from:

```js
const currentImageCapabilityReady = Boolean(
    releaseClaims?.releaseEligible &&
    userscriptArtifact?.releaseEligible &&
    releaseVersionDocs?.releaseEligible &&
    imageReleaseEvidence?.releaseEligible &&
    videoProductionDefaults?.releaseEligible
);
```

Keep Allenk/V2, visible residual research, video denoise, video review delivery, and video alpha-shape in `blockedClaims` and the claim matrix, but do not include them in the `image-defaults` release-ready conjunction. Preserve the existing legacy behavior when no scope is supplied so tests can identify accidental unscoped calls.

Update `RELEASE_QUALITY_GATE_SCRIPT` to the exact scoped command and include the three new image evidence scripts in the release-script contract checks.

- [ ] **Step 5: Add `--scope image-defaults` CLI parsing and report fields**

Store `report.releaseScope = scope`, render it in Markdown, reject unknown scopes, and require `--scope image-defaults` when `--fail-on-not-ready` is used for this release path.

- [ ] **Step 6: Run readiness tests and verify GREEN**

Run:

```powershell
node --test tests/scripts/releaseReadinessReport.test.js
```

Expected: all existing and scoped readiness tests pass.

- [ ] **Step 7: Commit scoped readiness**

```powershell
git add scripts/create-release-readiness-report.js tests/scripts/releaseReadinessReport.test.js
git commit -m "feat: scope release readiness to image evidence"
```

---

### Task 4: Goal Audit, Script Contracts, and Release Documentation

**Files:**
- Modify: `scripts/create-release-goal-audit-report.js`
- Modify: `tests/scripts/releaseGoalAuditReport.test.js`
- Modify: `package.json`
- Modify: `tests/scripts/scriptEntrypoints.test.js`
- Modify: `tests/project/releaseMetadata.test.js`
- Modify: `RELEASE.md`
- Modify: `RELEASE_zh.md`

**Interfaces:**
- Consumes: scoped readiness with a current image evidence lane and claim guards.
- Produces: exact package scripts and a goal audit whose scoped RC objective is achieved without broad V2/video evidence.

- [ ] **Step 1: Write failing goal-audit and metadata tests**

Update `releaseScripts()` and the expected entrypoint maps to the four exact scripts from Task 3. Replace the old `allenk-v2-comparison-current` requirement with:

```js
{
    id: 'image-release-evidence-current',
    satisfied: readiness.overall.releaseEvidenceIndex?.imageQuality?.status === 'current' &&
        readiness.overall.releaseEvidenceIndex?.imageQuality?.gateOk === true
}
```

Add a test proving `goalAchieved === true` when Allenk status is `missing-evidence` but image evidence is current and forbidden-claim guards are active. Add a second test proving stale image evidence fails `--fail-on-incomplete`.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```powershell
node --test tests/scripts/releaseGoalAuditReport.test.js tests/project/releaseMetadata.test.js tests/scripts/scriptEntrypoints.test.js
```

Expected: failures reference the old quality-gate string and old Allenk completion objective.

- [ ] **Step 3: Update package scripts and goal audit**

Set these exact package scripts:

```json
{
  "release:image-validation": "node scripts/run-image-release-validation.js",
  "release:image-evidence": "node scripts/create-image-release-evidence.js",
  "release:image-quality-gate": "node scripts/check-image-release-evidence.js",
  "release:quality-gate": "pnpm release:image-quality-gate && pnpm compare:allenk-v2 && pnpm release:readiness -- --scope image-defaults --fail-on-not-ready"
}
```

Keep `release:preflight` unchanged except that it calls the newly defined `release:quality-gate`. Update `create-release-goal-audit-report.js` constants, six requirements, status derivation, and Markdown so the goal is the scoped image RC rather than complete historical Allenk evidence.

- [ ] **Step 4: Update bilingual release documentation**

In `RELEASE.md` and `RELEASE_zh.md`, state:

- run `pnpm release:image-validation` and `pnpm release:image-evidence` when image production sources or the package change;
- `release:image-quality-gate` verifies pinned 36/424/exact-96 evidence and rejects video source changes;
- `compare:allenk-v2` remains a claim audit and does not imply broad V2/video readiness;
- `release:readiness -- --scope image-defaults --fail-on-not-ready` is the scoped gate;
- broad V2/video claims remain forbidden until their dedicated evidence is current.

Do not advertise new video behavior or broad V2 support.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```powershell
node --test tests/scripts/releaseGoalAuditReport.test.js tests/project/releaseMetadata.test.js tests/scripts/scriptEntrypoints.test.js
```

Expected: all goal-audit and metadata tests pass.

- [ ] **Step 6: Commit release contracts and docs**

```powershell
git add scripts/create-release-goal-audit-report.js tests/scripts/releaseGoalAuditReport.test.js package.json tests/scripts/scriptEntrypoints.test.js tests/project/releaseMetadata.test.js RELEASE.md RELEASE_zh.md
git commit -m "docs: bind release checks to scoped image evidence"
```

---

### Task 5: Generate v1.0.30 Evidence and Close the Local Release Gate

**Files:**
- Generate: `.artifacts/release-image-quality/automated-results.json`
- Create: `release/evidence/v1.0.30-image-quality.json`
- Verify: `release/gemini-watermark-remover-extension-v1.0.30.zip`
- Verify: `release/gemini-watermark-remover-extension-v1.0.30.zip.sha256.txt`
- Verify: `release/latest-extension.json`

**Interfaces:**
- Consumes: the current real 36/424/manual reports and completed implementation tree.
- Produces: pinned v1.0.30 evidence and passing local release quality/readiness/goal gates.

- [ ] **Step 1: Confirm source reports before generating evidence**

Run:

```powershell
node -e "const fs=require('fs');for(const p of ['.artifacts/top-n-candidate-selection/contrast-report.json','.artifacts/same-anchor-96-imperfection-preference/before-424-report.json','.artifacts/expanded-sample-validation/curated-top-n/combined-report.json','.artifacts/same-anchor-imperfection-review/report.json','.artifacts/same-anchor-imperfection-review/review.json']){if(!fs.existsSync(p))throw new Error('missing '+p)}"
```

Expected: exit `0` with no missing artifact.

- [ ] **Step 2: Run machine-readable automated validation**

Run:

```powershell
pnpm release:image-validation
```

Expected: full test `1316 pass / 28 skip / 0 fail`, SDK smoke `8/8`, build success, extension package success. If totals differ only because new gate tests were added, require `failed=0`, preserve the original 1316 passing tests, and record the larger new total accurately.

- [ ] **Step 3: Generate pinned evidence**

Run:

```powershell
pnpm release:image-evidence
```

Expected: `release/evidence/v1.0.30-image-quality.json` records contrast `36`, curated `424`, candidate changes `10`, position/status changes `0`, exact-96 verdicts `7/3/0/0`, and current release zip hash/size.

- [ ] **Step 4: Run the scoped quality gate**

Run:

```powershell
pnpm release:quality-gate
```

Expected: image quality gate passes; Allenk report may remain `missing-evidence` and must keep broad V2/video claims blocked; scoped readiness exits `0` with `rc-current-image-defaults-with-scoped-claims`.

- [ ] **Step 5: Run goal audit and full local regression**

Run:

```powershell
pnpm release:goal-audit -- --fail-on-incomplete
pnpm test
pnpm test:sdk-smoke
pnpm build
pnpm package:extension
git diff --check
```

Expected: goal achieved, tests/build/package pass, and no whitespace errors.

- [ ] **Step 6: Commit pinned evidence and final gate files**

Stage only implementation, tests, docs, package metadata, v1.0.30 release assets, and the evidence JSON. Do not stage `.artifacts` or unrelated historical release files.

```powershell
git add CHANGELOG.md CHANGELOG_zh.md package.json RELEASE.md RELEASE_zh.md release/latest-extension.json release/gemini-watermark-remover-extension-v1.0.30.zip release/gemini-watermark-remover-extension-v1.0.30.zip.sha256.txt release/evidence/v1.0.30-image-quality.json
git add src/core/adaptiveDetector.js src/core/candidateEvaluation.js src/core/candidateSelector.js src/core/darkOutlineContourRepair.js src/core/embeddedAlphaMaps.js src/core/embeddedDarkOutlineAlphaMap.js src/core/embeddedOutlineAlphaMap.js src/core/imageWatermarkPipeline.js src/core/pipelineAcceptedExecutor.js src/core/pipelineCandidatePool.js src/core/pipelineCandidateQuality.js src/core/pipelineCandidateRunner.js src/core/pipelineFinalization.js src/core/pipelineInitialSelection.js src/core/pipelineMeta.js src/core/pipelineRepairGates.js src/core/pipelineRepairStageSpecs.js src/core/pipelineResult.js src/core/restorationMetrics.js src/core/watermarkEngine.js src/core/watermarkProcessor.js src/sdk/image-data.js
git add scripts/image-release-evidence.js scripts/run-image-release-validation.js scripts/create-image-release-evidence.js scripts/check-image-release-evidence.js scripts/create-release-readiness-report.js scripts/create-release-goal-audit-report.js scripts/run-same-anchor-imperfection-review.js scripts/same-anchor-imperfection-review.js scripts/summarize-same-anchor-imperfection-review.js
git add tests/core/adaptiveDetector.test.js tests/core/candidateEvaluation.test.js tests/core/candidateSelector.test.js tests/core/imageWatermarkPipeline.test.js tests/core/pipelineAcceptedExecutor.test.js tests/core/pipelineCandidatePool.test.js tests/core/pipelineCandidateQuality.test.js tests/core/pipelineCandidateRunner.test.js tests/core/pipelineFinalization.test.js tests/core/pipelineInitialSelection.test.js tests/core/pipelineMeta.test.js tests/core/pipelineRepairGates.test.js tests/core/pipelineRepairStageSpecs.test.js tests/core/pipelineResult.test.js tests/core/pipelineRuntimeBootstrap.test.js tests/core/restorationMetrics.test.js tests/core/watermarkProcessor.test.js tests/regression/sampleAssetsRemoval.test.js tests/sdk/publicApi.test.js
git add tests/scripts/imageReleaseEvidence.test.js tests/scripts/releaseReadinessReport.test.js tests/scripts/releaseGoalAuditReport.test.js tests/scripts/scriptEntrypoints.test.js tests/scripts/runSameAnchorImperfectionReview.test.js tests/scripts/sameAnchorImperfectionReview.test.js tests/scripts/summarizeSameAnchorImperfectionReview.test.js tests/project/releaseMetadata.test.js
git add tests/fixtures/issue101-outline-dark-landscape.png tests/fixtures/issue101-outline-dark-low-body-landscape.png tests/fixtures/issue101-outline-light-portrait.png tests/fixtures/issue101-weak-dark-polarity-damage.png tests/fixtures/issue104-aggressive-polarity-overshoot.png
git add docs/superpowers/plans/2026-07-16-same-anchor-96-imperfection-preference.md docs/superpowers/plans/2026-07-16-same-anchor-clean-dominance.md docs/superpowers/specs/2026-07-16-same-anchor-96-imperfection-preference-design.md docs/superpowers/specs/2026-07-16-same-anchor-clean-dominance-design.md
git commit -m "release: prepare scoped v1.0.30 quality evidence"
```

- [ ] **Step 7: Push candidate and wait for current-HEAD CI**

Run:

```powershell
git push origin main
gh run list --repo GargantuaX/gemini-watermark-remover --workflow ci.yml --limit 5
```

Expected: the run for the pushed HEAD completes successfully. Do not tag or publish while it is pending, action-required, cancelled, or failed.

- [ ] **Step 8: Run final preflight**

Run:

```powershell
pnpm release:preflight
```

Expected: build, full tests, packaging, scoped quality gate, goal audit, and current-HEAD CI check all pass. Only after this result is v1.0.30 ready for tag/GitHub Release/npm/website publication.
