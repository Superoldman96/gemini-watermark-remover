# Same-Anchor 96px Imperfection Preference Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Promote the visually cleaner exact-`96x96` same-anchor Top-N candidate when its imperfection score improves by at least `0.15` and its evidence and damage losses stay within the validated `+0.05` tolerances.

**Architecture:** Keep the existing candidate scoring and base sort unchanged. Add one pure post-ranking list transformation in `pipelineCandidateQuality.js`, then calculate rank and selection confidence from the transformed order. The rule is exact-96-only, requires a high-severity incumbent, rejects catastrophic candidates, and falls back to the untouched base order whenever required signals are absent or outside tolerance.

**Tech Stack:** JavaScript ES modules, Node.js `node:test`, pnpm, Sharp, the current 36-image contrast set, and the current 424-image `2026-07-15` sample report.

**Execution Result (2026-07-16):** Complete. The final rule changes exactly the 10 reviewed exact-96 selections (`7` visually better, `3` ties), preserves every position and quality status, passes the 36-image contrast set and final 424-image batch with zero errors/catastrophic blocks/retries, preserves the `20260617.png` standard-alpha regression baseline, passes all `1344` repository tests (`28` fixture-dependent skips), and builds the production artifact successfully.

## Global Constraints

- Apply only when the incumbent structured position is exactly `96x96`; `48x48`, `94x94`, non-square, and every other size must remain unchanged.
- Require the incumbent imperfection severity to be exactly `high`.
- Require a finite alternative imperfection score at least `0.15` lower than the incumbent.
- Allow alternative evidence loss up to and including `incumbent + 0.05`.
- Allow alternative damage loss up to and including `incumbent + 0.05`.
- Do not add a residual-loss eligibility tolerance; residual loss is only the second deterministic tie-breaker.
- Do not change candidate discovery, Top-N count, alpha maps, alpha gains, geometry search, cleanup algorithms, global final-score weights, discovery penalties, or catastrophic-block protection.
- Do not add dependencies or start local development services.
- Use `pnpm`, never `npm` or `npx`.
- Treat the configured sample root as read-only.
- Write generated validation evidence only under `.artifacts/same-anchor-96-imperfection-preference` and the existing validation output roots.
- `src/core/pipelineCandidateQuality.js` and `tests/core/pipelineCandidateQuality.test.js` are pre-existing untracked/overlapping worktree files. Do not stage or commit them without explicit user approval; use scoped diffs and tests instead.

---

### Task 1: Freeze the current production and visual baselines

**Files:**
- Read: `.artifacts/expanded-sample-validation/curated-top-n/combined-report.json`
- Read: `.artifacts/same-anchor-imperfection-review/report.json`
- Read: `.artifacts/same-anchor-imperfection-review/review.json`
- Read: `.artifacts/same-anchor-imperfection-review/summary.json`
- Generated: `.artifacts/same-anchor-96-imperfection-preference/before-424-report.json`
- Generated: `.artifacts/same-anchor-96-imperfection-preference/before-review/`

**Interfaces:**
- Consumes: the checked 424-sample production report and 26-item manual review produced before the production rule.
- Produces: immutable task-local baseline copies used by the exact before/after assertions in Task 4.

- [ ] **Step 1: Create the task-local artifact root**

Run:

```powershell
New-Item -ItemType Directory -Force -Path '.artifacts/same-anchor-96-imperfection-preference/before-review' | Out-Null
```

Expected: the directory exists inside the repository artifact root; no source or sample file changes.

- [ ] **Step 2: Copy the current 424 report and reviewed diagnostic evidence**

Run:

```powershell
Copy-Item -LiteralPath '.artifacts/expanded-sample-validation/curated-top-n/combined-report.json' -Destination '.artifacts/same-anchor-96-imperfection-preference/before-424-report.json' -Force
Copy-Item -LiteralPath '.artifacts/same-anchor-imperfection-review/report.json' -Destination '.artifacts/same-anchor-96-imperfection-preference/before-review/report.json' -Force
Copy-Item -LiteralPath '.artifacts/same-anchor-imperfection-review/review.json' -Destination '.artifacts/same-anchor-96-imperfection-preference/before-review/review.json' -Force
Copy-Item -LiteralPath '.artifacts/same-anchor-imperfection-review/summary.json' -Destination '.artifacts/same-anchor-96-imperfection-preference/before-review/summary.json' -Force
Copy-Item -LiteralPath '.artifacts/same-anchor-imperfection-review/contact-sheet.png' -Destination '.artifacts/same-anchor-96-imperfection-preference/before-review/contact-sheet.png' -Force
Copy-Item -LiteralPath '.artifacts/same-anchor-imperfection-review/triplets' -Destination '.artifacts/same-anchor-96-imperfection-preference/before-review/triplets' -Recurse -Force
```

Expected: the copied 424 report has `424` results and the copied review contains all 26 decisions and triplets.

- [ ] **Step 3: Validate the exact-96 baseline contract**

Run:

```powershell
node -e "const fs=require('fs');const assert=require('assert');const b=JSON.parse(fs.readFileSync('.artifacts/same-anchor-96-imperfection-preference/before-424-report.json'));const r=JSON.parse(fs.readFileSync('.artifacts/same-anchor-96-imperfection-preference/before-review/report.json'));const v=JSON.parse(fs.readFileSync('.artifacts/same-anchor-96-imperfection-preference/before-review/review.json'));const verdict=new Map(v.decisions.map(x=>[x.fileName,x.verdict]));const exact=r.records.filter(x=>x.status==='matched'&&x.selected.position.width===96&&x.selected.position.height===96);assert.equal(b.results.length,424);assert.equal(exact.length,10);assert.deepEqual(exact.reduce((a,x)=>(a[verdict.get(x.fileName)]=(a[verdict.get(x.fileName)]||0)+1,a),{}),{'tie':3,'alternative-better':7});assert(exact.every(x=>x.selected.position.x===x.alternative.position.x&&x.selected.position.y===x.alternative.position.y&&x.selected.position.width===x.alternative.position.width&&x.selected.position.height===x.alternative.position.height));console.log({samples:b.results.length,exact96:exact.length});"
```

Expected: prints `{ samples: 424, exact96: 10 }` and exits `0`.

---

### Task 2: Implement the exact-96 post-ranking preference as a pure function with TDD

**Files:**
- Modify: `tests/core/pipelineCandidateQuality.test.js`
- Modify: `src/core/pipelineCandidateQuality.js`

**Interfaces:**
- Consumes: a base-ranked `CompletedCandidate[]` whose entries already contain `hypothesis`, `qualitySignals`, `finalScore`, and discovery metadata.
- Produces: `applySameAnchor96ImperfectionPreference(baseRanked): CompletedCandidate[]`.
- Leaves the input order unchanged when the incumbent or every alternative is ineligible.

- [ ] **Step 1: Add the pure-function import and focused test helpers**

Modify the import in `tests/core/pipelineCandidateQuality.test.js`:

```js
import {
    applySameAnchor96ImperfectionPreference,
    classifyCandidateQuality,
    createCandidateImperfectionSignals,
    createCandidateQualitySignals,
    createCandidateSummaries,
    rankCompletedCandidates
} from '../../src/core/pipelineCandidateQuality.js';
```

Add these helpers after `createCompletedAt`:

```js
function createPreferenceSignals({
    evidenceLoss = 0.1,
    residualLoss = 0.2,
    damageLoss = 0.1,
    imperfectionScore = 2,
    imperfectionSeverity = 'high',
    catastrophic = false
} = {}) {
    return {
        evidenceLoss,
        residualLoss,
        damageLoss,
        residualVisible: true,
        damageWarning: false,
        qualityStatus: 'visible-residual',
        imperfections: {
            detected: true,
            severity: imperfectionSeverity,
            score: imperfectionScore,
            types: ['gradient-residual']
        },
        texture: catastrophic ? { hardReject: true } : { hardReject: false },
        damageComponents: catastrophic
            ? { clipped: 1, nearBlack: 1, nearWhite: 0 }
            : { clipped: 0, nearBlack: 0, nearWhite: 0 }
    };
}

function createPreferenceCandidate(id, signals, {
    position = { x: 100, y: 120, width: 96, height: 96 },
    discoveryRole = 'fixed-selected',
    finalScore = 0
} = {}) {
    return {
        ...createCompletedAt(id, signals, { position, discoveryRole }),
        finalScore
    };
}
```

- [ ] **Step 2: Write failing tests for promotion, scope, tolerance, and deterministic order**

Append:

```js
test('applySameAnchor96ImperfectionPreference should promote an eligible candidate and preserve the remaining base order', () => {
    const incumbent = createPreferenceCandidate('incumbent', createPreferenceSignals());
    const unrelated = createPreferenceCandidate('unrelated', createPreferenceSignals({
        imperfectionScore: 3
    }), {
        position: { x: 101, y: 120, width: 96, height: 96 }
    });
    const alternative = createPreferenceCandidate('alternative', createPreferenceSignals({
        evidenceLoss: 0.15,
        residualLoss: 0.7,
        damageLoss: 0.15,
        imperfectionScore: 1.999
    }));

    const preferred = applySameAnchor96ImperfectionPreference([
        incumbent,
        unrelated,
        alternative
    ]);

    assert.deepEqual(preferred.map((candidate) => candidate.hypothesis.id), [
        'alternative',
        'incumbent',
        'unrelated'
    ]);
});

test('applySameAnchor96ImperfectionPreference should keep non-exact-96 and different-anchor base rankings unchanged', () => {
    for (const position of [
        { x: 10, y: 20, width: 48, height: 48 },
        { x: 10, y: 20, width: 94, height: 94 },
        { x: 10, y: 20, width: 96, height: 95 }
    ]) {
        const incumbent = createPreferenceCandidate('incumbent', createPreferenceSignals(), { position });
        const alternative = createPreferenceCandidate('alternative', createPreferenceSignals({
            imperfectionScore: 0.1
        }), { position });
        assert.deepEqual(
            applySameAnchor96ImperfectionPreference([incumbent, alternative]),
            [incumbent, alternative]
        );
    }

    const incumbent = createPreferenceCandidate('incumbent', createPreferenceSignals());
    const shifted = createPreferenceCandidate('shifted', createPreferenceSignals({
        imperfectionScore: 0.1
    }), {
        position: { x: 101, y: 120, width: 96, height: 96 }
    });
    assert.deepEqual(
        applySameAnchor96ImperfectionPreference([incumbent, shifted]),
        [incumbent, shifted]
    );
});

test('applySameAnchor96ImperfectionPreference should require complete high-severity incumbent signals', () => {
    for (const signals of [
        createPreferenceSignals({ imperfectionSeverity: 'moderate' }),
        createPreferenceSignals({ imperfectionScore: Number.NaN }),
        createPreferenceSignals({ evidenceLoss: Number.NaN }),
        createPreferenceSignals({ damageLoss: Number.NaN })
    ]) {
        const incumbent = createPreferenceCandidate('incumbent', signals);
        const alternative = createPreferenceCandidate('alternative', createPreferenceSignals({
            imperfectionScore: 0.1
        }));
        assert.equal(
            applySameAnchor96ImperfectionPreference([incumbent, alternative])[0],
            incumbent
        );
    }
});

test('applySameAnchor96ImperfectionPreference should include tolerance boundaries and reject unsafe or invalid alternatives', () => {
    const incumbent = createPreferenceCandidate('incumbent', createPreferenceSignals());
    const boundary = createPreferenceCandidate('boundary', createPreferenceSignals({
        evidenceLoss: 0.15,
        damageLoss: 0.15,
        imperfectionScore: 1
    }));
    assert.equal(
        applySameAnchor96ImperfectionPreference([incumbent, boundary])[0],
        boundary
    );

    for (const candidate of [
        createPreferenceCandidate('evidence-over', createPreferenceSignals({
            evidenceLoss: 0.150001,
            imperfectionScore: 0.1
        })),
        createPreferenceCandidate('damage-over', createPreferenceSignals({
            damageLoss: 0.150001,
            imperfectionScore: 0.1
        })),
        createPreferenceCandidate('invalid', createPreferenceSignals({
            imperfectionScore: Number.NaN
        })),
        createPreferenceCandidate('catastrophic', createPreferenceSignals({
            imperfectionScore: 0.1,
            catastrophic: true
        }))
    ]) {
        assert.equal(
            applySameAnchor96ImperfectionPreference([incumbent, candidate])[0],
            incumbent,
            candidate.hypothesis.id
        );
    }
});

test('applySameAnchor96ImperfectionPreference should choose by imperfection residual and base order', () => {
    const incumbent = createPreferenceCandidate('incumbent', createPreferenceSignals());
    const earlier = createPreferenceCandidate('earlier', createPreferenceSignals({
        residualLoss: 0.3,
        imperfectionScore: 0.5
    }));
    const lowerResidual = createPreferenceCandidate('lower-residual', createPreferenceSignals({
        residualLoss: 0.1,
        imperfectionScore: 0.5
    }));
    assert.equal(
        applySameAnchor96ImperfectionPreference([
            incumbent,
            earlier,
            lowerResidual
        ])[0],
        lowerResidual
    );

    const sameA = createPreferenceCandidate('same-a', createPreferenceSignals({
        residualLoss: 0.1,
        imperfectionScore: 0.5
    }));
    const sameB = createPreferenceCandidate('same-b', createPreferenceSignals({
        residualLoss: 0.1,
        imperfectionScore: 0.5
    }));
    assert.equal(
        applySameAnchor96ImperfectionPreference([incumbent, sameB, sameA])[0],
        sameB
    );
});
```

- [ ] **Step 3: Run the focused test and verify RED**

Run:

```powershell
node --test tests/core/pipelineCandidateQuality.test.js
```

Expected: FAIL because `applySameAnchor96ImperfectionPreference` is not exported.

- [ ] **Step 4: Implement the minimal pure post-ranking preference**

Add after `hasSameCandidateAnchor` in `src/core/pipelineCandidateQuality.js`:

```js
const SAME_ANCHOR_96_SIZE = 96;
const SAME_ANCHOR_96_IMPERFECTION_IMPROVEMENT = 0.15;
const SAME_ANCHOR_96_EVIDENCE_TOLERANCE = 0.05;
const SAME_ANCHOR_96_DAMAGE_TOLERANCE = 0.05;

function finiteOr(value, fallback = Infinity) {
    return Number.isFinite(value) ? value : fallback;
}

function isEligibleSameAnchor96Alternative(incumbent, alternative) {
    const incumbentSignals = incumbent?.qualitySignals ?? {};
    const alternativeSignals = alternative?.qualitySignals ?? {};
    const incumbentScore = incumbentSignals.imperfections?.score;
    const alternativeScore = alternativeSignals.imperfections?.score;
    return hasSameCandidateAnchor(incumbent, alternative) &&
        !hasCatastrophicBlock(alternativeSignals) &&
        Number.isFinite(alternativeScore) &&
        alternativeScore <=
            incumbentScore - SAME_ANCHOR_96_IMPERFECTION_IMPROVEMENT &&
        Number.isFinite(alternativeSignals.evidenceLoss) &&
        alternativeSignals.evidenceLoss <=
            incumbentSignals.evidenceLoss + SAME_ANCHOR_96_EVIDENCE_TOLERANCE &&
        Number.isFinite(alternativeSignals.damageLoss) &&
        alternativeSignals.damageLoss <=
            incumbentSignals.damageLoss + SAME_ANCHOR_96_DAMAGE_TOLERANCE;
}

export function applySameAnchor96ImperfectionPreference(baseRanked = []) {
    const incumbent = baseRanked[0];
    const position = getCandidatePosition(incumbent);
    const signals = incumbent?.qualitySignals ?? {};
    if (
        !position ||
        position.width !== SAME_ANCHOR_96_SIZE ||
        position.height !== SAME_ANCHOR_96_SIZE ||
        signals.imperfections?.severity !== 'high' ||
        !Number.isFinite(signals.imperfections?.score) ||
        !Number.isFinite(signals.evidenceLoss) ||
        !Number.isFinite(signals.damageLoss)
    ) {
        return baseRanked;
    }

    const eligible = baseRanked
        .slice(1)
        .map((candidate, offset) => ({ candidate, baseIndex: offset + 1 }))
        .filter(({ candidate }) =>
            isEligibleSameAnchor96Alternative(incumbent, candidate)
        )
        .sort((left, right) =>
            left.candidate.qualitySignals.imperfections.score -
                right.candidate.qualitySignals.imperfections.score ||
            finiteOr(left.candidate.qualitySignals.residualLoss) -
                finiteOr(right.candidate.qualitySignals.residualLoss) ||
            left.baseIndex - right.baseIndex ||
            String(left.candidate.hypothesis?.id ?? '').localeCompare(
                String(right.candidate.hypothesis?.id ?? '')
            )
        );
    if (eligible.length === 0) return baseRanked;

    const promoted = eligible[0].candidate;
    return [promoted, ...baseRanked.filter((candidate) => candidate !== promoted)];
}
```

- [ ] **Step 5: Run the focused test and verify GREEN**

Run:

```powershell
node --test tests/core/pipelineCandidateQuality.test.js
```

Expected: all existing and new candidate-quality tests pass. Do not stage or commit the overlapping implementation/test files.

---

### Task 3: Integrate the preference after the existing base sort with TDD

**Files:**
- Modify: `tests/core/pipelineCandidateQuality.test.js`
- Modify: `src/core/pipelineCandidateQuality.js`

**Interfaces:**
- Consumes: `applySameAnchor96ImperfectionPreference(scored)` from Task 2.
- Produces: `rankCompletedCandidates(completed)` whose rank 1 reflects the exact-96 post-ranking preference and whose remaining order, ranks, summaries, and confidence remain internally consistent.

- [ ] **Step 1: Write a failing integration test proving the preference runs after base ranking**

Append:

```js
test('rankCompletedCandidates should apply exact-96 imperfection preference after base scoring', () => {
    const incumbent = createPreferenceCandidate('incumbent', createPreferenceSignals({
        evidenceLoss: 0.1,
        residualLoss: 0.1,
        damageLoss: 0.1,
        imperfectionScore: 2
    }));
    const alternative = createPreferenceCandidate('alternative', createPreferenceSignals({
        evidenceLoss: 0.15,
        residualLoss: 0.2,
        damageLoss: 0.15,
        imperfectionScore: 1
    }));

    const ranked = rankCompletedCandidates([incumbent, alternative]);

    assert.deepEqual(ranked.map((candidate) => candidate.hypothesis.id), [
        'alternative',
        'incumbent'
    ]);
    assert.equal(ranked[0].rank, 1);
    assert.equal(ranked[1].rank, 2);
    assert.equal(ranked[0].selectionConfidence, 0);
});
```

The incumbent has the lower aggregate final score and dominates the alternative under the existing losses. The test therefore proves the new result is produced by the post-ranking preference rather than accidental base scoring.

- [ ] **Step 2: Temporarily keep `rankCompletedCandidates` unchanged and verify RED**

Run:

```powershell
node --test tests/core/pipelineCandidateQuality.test.js
```

Expected: only the new integration test fails with incumbent still ranked first.

- [ ] **Step 3: Apply the pure preference after the base sort**

Replace the final portion of `rankCompletedCandidates`:

```js
    scored.sort(compareRankedCandidates);
    const preferred = applySameAnchor96ImperfectionPreference(scored);

    const first = preferred[0];
    const second = preferred[1];
    const selectionConfidence = !first
        ? 0
        : !second
            ? 1
            : clamp01((second.finalScore - first.finalScore) / Math.max(0.05, second.finalScore));

    return preferred.map((item, index) => ({
        ...item,
        rank: index + 1,
        selectionConfidence: index === 0 ? selectionConfidence : 0
    }));
```

- [ ] **Step 4: Run the focused ranking and pipeline tests**

Run:

```powershell
node --test tests/core/pipelineCandidateQuality.test.js tests/core/imageWatermarkPipeline.test.js tests/core/pipelineMeta.test.js
```

Expected: all tests pass, including existing clean dominance, deterministic ranking, failure isolation, and candidate-summary pixel-leak checks.

- [ ] **Step 5: Audit only the scoped implementation diff**

Run:

```powershell
git -c safe.directory=$PWD diff --check -- src/core/pipelineCandidateQuality.js tests/core/pipelineCandidateQuality.test.js
git -c safe.directory=$PWD diff -- src/core/pipelineCandidateQuality.js tests/core/pipelineCandidateQuality.test.js
```

Expected: the new diff is limited to one pure preference helper, one integration call after the existing base sort, test helpers, and focused tests. Do not stage or commit these overlapping files.

---

### Task 4: Verify the 10 reviewed exact-96 outputs and the 36/424 boundaries

**Files:**
- Create: `.artifacts/same-anchor-96-imperfection-preference/run-targeted-after.mjs`
- Generated: `.artifacts/same-anchor-96-imperfection-preference/after-targeted/`
- Generated: `.artifacts/top-n-candidate-selection/contrast-report.json`
- Generated: `.artifacts/expanded-sample-validation/curated-top-n/combined-report.json`
- Compare: `.artifacts/same-anchor-96-imperfection-preference/before-424-report.json`
- Compare: `.artifacts/same-anchor-96-imperfection-preference/before-review/report.json`
- Compare: `.artifacts/same-anchor-96-imperfection-preference/before-review/review.json`

**Interfaces:**
- Consumes: the production ranking from Task 3 and the frozen diagnostic expected alternative IDs from Task 1.
- Produces: 10 rendered post-change outputs/crops, exact selected-ID assertions, contrast safety results, and the 424 before/after scope proof.

- [ ] **Step 1: Create the targeted post-change renderer and ID verifier**

Use `apply_patch` to create `.artifacts/same-anchor-96-imperfection-preference/run-targeted-after.mjs`:

```js
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import sharp from 'sharp';

import { removeWatermarkFromImageDataSync } from '../../src/sdk/image-data.js';

const root = path.resolve('.artifacts/same-anchor-96-imperfection-preference');
const evidenceRoot = path.join(root, 'before-review');
const outputRoot = path.join(root, 'after-targeted');
const report = JSON.parse(await readFile(path.join(evidenceRoot, 'report.json'), 'utf8'));
const review = JSON.parse(await readFile(path.join(evidenceRoot, 'review.json'), 'utf8'));
const verdictByFile = new Map(review.decisions.map((item) => [item.fileName, item.verdict]));
const targets = report.records.filter((record) =>
    record.status === 'matched' &&
    record.selected.position.width === 96 &&
    record.selected.position.height === 96 &&
    ['alternative-better', 'tie'].includes(verdictByFile.get(record.fileName))
);
assert.equal(targets.length, 10);
await mkdir(outputRoot, { recursive: true });

async function decode(filePath) {
    const { data, info } = await sharp(filePath, { limitInputPixels: false })
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
    return {
        width: info.width,
        height: info.height,
        data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength)
    };
}

async function encode(filePath, imageData) {
    await sharp(Buffer.from(
        imageData.data.buffer,
        imageData.data.byteOffset,
        imageData.data.byteLength
    ), {
        raw: {
            width: imageData.width,
            height: imageData.height,
            channels: 4
        }
    }).png().toFile(filePath);
}

function createCrop(position, imageData, padding = 24) {
    const left = Math.max(0, position.x - padding);
    const top = Math.max(0, position.y - padding);
    return {
        left,
        top,
        width: Math.min(imageData.width - left, position.width + padding * 2),
        height: Math.min(imageData.height - top, position.height + padding * 2)
    };
}

const records = [];
for (const target of targets) {
    const imageData = await decode(target.input);
    const result = removeWatermarkFromImageDataSync(imageData, {
        adaptiveMode: 'auto',
        debugTimings: true
    });
    assert.equal(
        result.meta?.selectedCandidate?.id,
        target.alternative.id,
        target.fileName
    );
    const stem = path.parse(target.fileName).name;
    const outputPath = path.join(outputRoot, `${stem}.png`);
    const cropPath = path.join(outputRoot, `${stem}-crop.png`);
    await encode(outputPath, result.imageData);
    await sharp(outputPath)
        .extract(createCrop(target.alternative.position, result.imageData))
        .png()
        .toFile(cropPath);
    records.push({
        fileName: target.fileName,
        expectedCandidateId: target.alternative.id,
        actualCandidateId: result.meta.selectedCandidate.id,
        qualityStatus: result.meta.qualityStatus,
        outputPath,
        cropPath
    });
}

await writeFile(
    path.join(outputRoot, 'report.json'),
    `${JSON.stringify({ count: records.length, records }, null, 2)}\n`,
    'utf8'
);
console.log(JSON.stringify({ count: records.length }, null, 2));
```

- [ ] **Step 2: Run the targeted verifier**

Run:

```powershell
node .artifacts/same-anchor-96-imperfection-preference/run-targeted-after.mjs
```

Expected: prints `{ "count": 10 }`; every actual selected candidate ID equals the reviewed alternative ID.

- [ ] **Step 3: Visually inspect all 10 post-change crops**

Compare each `after-targeted/*-crop.png` with the corresponding copied `before-review/triplets/*.png`. The baseline triplet columns are source/current/reviewed-alternative, so the post-change crop must visually match the reviewed right column.

For every crop verify:

- watermark body and tips are weaker or visually tied
- no new bright/dark outline or halo
- no black hole, white block, clipped patch, or local color cast
- nearby text, fabric, hair, edges, and structured texture remain intact

Expected: the existing manual verdict remains 7 improvements, 3 ties, 0 regressions. Any regression stops the rollout and returns to the production-rule design.

- [ ] **Step 4: Run the 36-image contrast set**

Run:

```powershell
node .artifacts/top-n-candidate-selection/run-contrast-validation.mjs
```

Expected: errors `0`, catastrophic blocks `0`, retry `0`, and recovered clean at least `15/16`.

- [ ] **Step 5: Re-run the 424-image suite in two parallel shards**

Run both commands concurrently:

```powershell
node .artifacts/expanded-sample-validation/run-expanded-image-validation.mjs --source "$env:GWR_SAMPLE_ROOT/RemoveGeminiWatermark/2026-07-15" --all-images --shard-count 2 --sample-order path --no-resume --shard-index 0 --out-dir .artifacts/expanded-sample-validation/curated-top-n/shard-0
```

```powershell
node .artifacts/expanded-sample-validation/run-expanded-image-validation.mjs --source "$env:GWR_SAMPLE_ROOT/RemoveGeminiWatermark/2026-07-15" --all-images --shard-count 2 --sample-order path --no-resume --shard-index 1 --out-dir .artifacts/expanded-sample-validation/curated-top-n/shard-1
```

Then summarize:

```powershell
node .artifacts/expanded-sample-validation/summarize-curated-validation.mjs --root .artifacts/expanded-sample-validation/curated-top-n
```

Expected: total `424`, errors `0`, catastrophic blocks `0`, retry `0`.

- [ ] **Step 6: Assert the exact before/after production scope**

Run:

```powershell
node -e "const fs=require('fs');const assert=require('assert');const before=JSON.parse(fs.readFileSync('.artifacts/same-anchor-96-imperfection-preference/before-424-report.json'));const after=JSON.parse(fs.readFileSync('.artifacts/expanded-sample-validation/curated-top-n/combined-report.json'));const evidence=JSON.parse(fs.readFileSync('.artifacts/same-anchor-96-imperfection-preference/before-review/report.json'));const review=JSON.parse(fs.readFileSync('.artifacts/same-anchor-96-imperfection-preference/before-review/review.json'));const verdict=new Map(review.decisions.map(x=>[x.fileName,x.verdict]));const expected=new Map(evidence.records.filter(x=>x.status==='matched'&&x.selected.position.width===96&&x.selected.position.height===96&&['alternative-better','tie'].includes(verdict.get(x.fileName))).map(x=>[x.fileName,x]));const beforeBy=new Map(before.results.map(x=>[x.fileName,x]));const changed=after.results.filter(x=>beforeBy.get(x.fileName)?.selectedCandidate?.id!==x.selectedCandidate?.id);assert.equal(expected.size,10);assert.equal(changed.length,10);for(const item of changed){const prior=beforeBy.get(item.fileName);const target=expected.get(item.fileName);assert(target,'unexpected change '+item.fileName);assert.equal(item.selectedCandidate.id,target.alternative.id);assert.deepEqual(item.selectedCandidate.position,prior.selectedCandidate.position);assert.equal(item.qualityStatus,prior.qualityStatus);}assert.equal(after.summary.errors,0);assert.equal(after.summary.catastrophicBlocks,0);assert.equal(after.summary.retryRecommended,0);console.log(changed.map(x=>({file:x.fileName,id:x.selectedCandidate.id,status:x.qualityStatus})));"
```

Expected: exits `0` and prints exactly 10 changed exact-96 records. No `48x48`, `94x94`, or other-size record changes; every quality status remains unchanged.

---

### Task 5: Run final repository regression and hand off the evidence

**Files:**
- Verify: `src/core/pipelineCandidateQuality.js`
- Verify: `tests/core/pipelineCandidateQuality.test.js`
- Verify: `.artifacts/same-anchor-96-imperfection-preference/after-targeted/report.json`
- Verify: `.artifacts/expanded-sample-validation/curated-top-n/combined-report.json`
- Verify: `.artifacts/top-n-candidate-selection/contrast-report.json`

**Interfaces:**
- Consumes: the visually and batch-validated implementation from Tasks 2-4.
- Produces: complete automated regression, production build, and a scoped uncommitted implementation ready for user review.

- [ ] **Step 1: Run focused implementation and diagnostic tests**

Run:

```powershell
node --test tests/core/pipelineCandidateQuality.test.js tests/core/imageWatermarkPipeline.test.js tests/core/pipelineMeta.test.js tests/scripts/sameAnchorImperfectionReview.test.js tests/scripts/runSameAnchorImperfectionReview.test.js tests/scripts/summarizeSameAnchorImperfectionReview.test.js
```

Expected: all focused tests pass.

- [ ] **Step 2: Run the full suite with process-local Git ownership configuration**

Run:

```powershell
$env:GIT_CONFIG_COUNT='1'
$env:GIT_CONFIG_KEY_0='safe.directory'
$env:GIT_CONFIG_VALUE_0=($PWD.Path -replace '\\','/')
pnpm test
```

Expected: `0` failures; fixture-dependent tests may remain skipped.

- [ ] **Step 3: Run the production build with the same process-local Git configuration**

Run:

```powershell
$env:GIT_CONFIG_COUNT='1'
$env:GIT_CONFIG_KEY_0='safe.directory'
$env:GIT_CONFIG_VALUE_0=($PWD.Path -replace '\\','/')
pnpm build
```

Expected: `Build complete!` and exit `0` without changing global Git configuration.

- [ ] **Step 4: Run final syntax and whitespace checks**

Run:

```powershell
node --check src/core/pipelineCandidateQuality.js
node --check tests/core/pipelineCandidateQuality.test.js
git -c safe.directory=$PWD diff --check -- src/core/pipelineCandidateQuality.js tests/core/pipelineCandidateQuality.test.js
```

Expected: all commands exit `0`.

- [ ] **Step 5: Report results without staging overlapping files**

Report:

- exact changed record count and IDs (`10` expected)
- 10-image visual verdict (`7` better, `3` tie, `0` worse expected)
- 36-image errors/catastrophic/retry/recovered-clean counts
- 424-image errors/catastrophic/retry counts and quality-status deltas
- full test and build results
- clickable paths to `after-targeted/report.json`, the targeted crops, the new 424 report, and the contrast report

Do not run `git add` or `git commit` for `src/core/pipelineCandidateQuality.js` or `tests/core/pipelineCandidateQuality.test.js` unless the user explicitly authorizes committing the overlapping worktree.
