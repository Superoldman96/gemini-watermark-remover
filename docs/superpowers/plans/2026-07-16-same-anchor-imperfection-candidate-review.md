# Same Anchor Imperfection Candidate Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 通过默认关闭的候选诊断回调，捕获 residual-risk 样本的全部已完成候选，并生成当前 top-1 与同 anchor 低瑕疵候选的三联图、复核记录和汇总报告。

**Architecture:** 在 `runImageWatermarkPipeline()` 的候选执行边界增加异常隔离的同步诊断回调，默认路径不复制候选像素、不改变排序。纯函数模块负责结构化 anchor 比较与备选筛选；CLI runner 对当前报告中的 residual-risk 样本重跑生产管线、编码三联图和 contact sheet；独立汇总器把人工复核结果聚合成下一轮生产设计证据。

**Tech Stack:** JavaScript ES modules、Node.js `node:test`、Sharp、现有同步 ImageData SDK、pnpm、本地 2026-07-15 样本报告。

## Global Constraints

- 本轮只增加诊断能力，不修改 discovery penalty、final score 权重、clean dominance、候选生成或生产 top-1。
- `options.onCandidateCompleted(candidate)` 默认关闭；未传回调时不做额外像素复制。
- 回调异常不得把成功候选变成失败候选；仅在启用 debug timings 时增加 `candidateDiagnosticErrorCount`。
- 候选 ImageData 不得进入 `meta` 或 `candidateSummaries`。
- anchor 必须比较结构化 `x/y/width/height`，不得解析 candidate ID。
- `evidenceLoss + 0.05` 与 `damageLoss + 0.05` 只用于诊断筛选，绝不直接进入生产排序。
- runner 读取报告中的全部 residual-risk 记录并重跑；只为重新验证后仍满足条件的样本生成对照，不硬凑 26 张。
- 输出只写 `.artifacts/same-anchor-imperfection-review/`，不修改源样本、gold baseline 或 424 合并报告。
- 当前工作区包含大量已有修改；不得自动暂存或提交与任务重叠的既有文件。实施完成后只做 scoped diff 审计，除非用户另行明确授权提交。

---

### Task 1: 增加异常隔离的候选诊断回调

**Files:**
- Modify: `src/core/imageWatermarkPipeline.js`
- Test: `tests/core/imageWatermarkPipeline.test.js`

**Interfaces:**
- Consumes: `options.onCandidateCompleted?: (candidate: CompletedCandidate) => void`
- Produces: 每个成功候选一次同步回调；`debugTimings.candidateDiagnosticErrorCount: number` 仅在回调抛错时出现。

- [ ] **Step 1: 扩展测试构造器以注入 options**

将 `createPipelineInput` 改为：

```js
function createPipelineInput({ hypotheses, failures = new Set(), options = {} }) {
    const imageData = createImageData();
    const alpha48 = new Float32Array(48 * 48).fill(0.5);
    const alpha96 = new Float32Array(96 * 96).fill(0.5);
    let clock = 0;
    const executed = [];

    return {
        executed,
        request: {
            imageData,
            options: { alpha48, alpha96, debugTimings: true, ...options },
            nowMs: () => ++clock,
            cloneImageData: (source) => ({
                width: source.width,
                height: source.height,
                data: new Uint8ClampedArray(source.data)
            }),
            alphaGainCandidates: [1],
            alphaPriorityGains: [1],
            cleanupConfig: {},
            createAcceptedPipelineDependencies: () => ({}),
            selectCandidate: () => ({ selectedTrial: null }),
            collectCandidates: () => ({ hypotheses }),
            runCandidate: ({ hypothesis }) => {
                executed.push(hypothesis.id);
                if (failures.has(hypothesis.id)) throw new Error(`failed:${hypothesis.id}`);
                return {
                    hypothesis,
                    result: {
                        imageData: createImageData(128, 128, hypothesis.id.length),
                        meta: {
                            applied: true,
                            source: `source:${hypothesis.id}`,
                            config: hypothesis.config,
                            position: hypothesis.position
                        },
                        debugTimings: { candidateMs: 1 }
                    },
                    elapsedMs: 1
                };
            },
            measureCandidate: ({ hypothesis }) => hypothesis.signals
        }
    };
}
```

- [ ] **Step 2: 写出成功候选回调的失败测试**

```js
test('runImageWatermarkPipeline should report each completed candidate to the diagnostic callback', () => {
    const captured = [];
    const hypotheses = [
        createHypothesis('standard', {
            qualityStatus: 'clean', evidenceLoss: 0.1, residualLoss: 0.1, damageLoss: 0
        }),
        createHypothesis('alpha', {
            qualityStatus: 'visible-residual', evidenceLoss: 0.1, residualLoss: 0.3, damageLoss: 0
        }),
        createHypothesis('failed', {})
    ];
    const { request } = createPipelineInput({
        hypotheses,
        failures: new Set(['failed']),
        options: { onCandidateCompleted: (candidate) => captured.push(candidate) }
    });

    const result = runImageWatermarkPipeline(request);

    assert.deepEqual(captured.map((candidate) => candidate.hypothesis.id), ['standard', 'alpha']);
    assert.equal(captured[0].result.imageData.width, 128);
    assert.equal(captured[0].qualitySignals.qualityStatus, 'clean');
    assert.equal('imageData' in result.meta.candidateSummaries[0], false);
});
```

- [ ] **Step 3: 写出回调异常隔离的失败测试**

```js
test('runImageWatermarkPipeline should isolate diagnostic callback failures', () => {
    const hypothesis = createHypothesis('standard', {
        qualityStatus: 'clean', evidenceLoss: 0.1, residualLoss: 0.1, damageLoss: 0
    });
    const { request } = createPipelineInput({
        hypotheses: [hypothesis],
        options: {
            onCandidateCompleted: () => {
                throw new Error('diagnostic failed');
            }
        }
    });

    const result = runImageWatermarkPipeline(request);

    assert.equal(result.meta.selectedCandidate.id, 'standard');
    assert.equal(result.debugTimings.completedCandidateCount, 1);
    assert.equal(result.debugTimings.failedCandidateCount, 0);
    assert.equal(result.debugTimings.candidateDiagnosticErrorCount, 1);
});
```

- [ ] **Step 4: 运行测试确认 RED**

Run:

```powershell
node --test tests/core/imageWatermarkPipeline.test.js
```

Expected: 两个新增测试失败；现有四个 pipeline 测试继续通过。

- [ ] **Step 5: 实现最小回调 helper**

在 `createRuntimeFailureResult` 之后增加：

```js
function notifyCandidateCompleted({ options, candidate, debugTimings }) {
    if (typeof options?.onCandidateCompleted !== 'function') return;
    try {
        options.onCandidateCompleted(candidate);
    } catch {
        if (debugTimings) {
            debugTimings.candidateDiagnosticErrorCount =
                (debugTimings.candidateDiagnosticErrorCount ?? 0) + 1;
        }
    }
}
```

把候选构造从直接 `completed.push({...})` 改成：

```js
const candidate = {
    ...completedCandidate,
    hypothesis,
    qualitySignals: measureCandidate({
        originalImageData,
        candidateImageData: completedCandidate.result.imageData,
        hypothesis
    })
};
completed.push(candidate);
notifyCandidateCompleted({ options, candidate, debugTimings });
```

- [ ] **Step 6: 运行聚焦测试确认 GREEN**

Run:

```powershell
node --test tests/core/imageWatermarkPipeline.test.js tests/core/pipelineCandidateQuality.test.js tests/core/pipelineMeta.test.js
```

Expected: 全部通过；默认路径的 meta 不包含候选像素。

- [ ] **Step 7: 审计 scoped diff，不提交既有重叠文件**

Run:

```powershell
git diff --check -- src/core/imageWatermarkPipeline.js tests/core/imageWatermarkPipeline.test.js
git diff -- src/core/imageWatermarkPipeline.js tests/core/imageWatermarkPipeline.test.js
```

Expected: 仅出现构造器 options、两个测试、callback helper 和调用点；保留工作区原有修改，不执行 `git add`。

---

### Task 2: 实现结构化同 Anchor 备选筛选纯函数

**Files:**
- Create: `scripts/same-anchor-imperfection-review.js`
- Test: `tests/scripts/sameAnchorImperfectionReview.test.js`

**Interfaces:**
- Produces: `getCandidatePosition(candidate)`, `hasSameAnchor(left, right)`, `selectSameAnchorAlternative({ selectedId, completedCandidates, evidenceTolerance, damageTolerance })`。
- Consumes: Task 1 callback 捕获的 `CompletedCandidate[]`。

- [ ] **Step 1: 写出结构化 anchor 与容差边界测试**

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    getCandidatePosition,
    hasSameAnchor,
    selectSameAnchorAlternative
} from '../../scripts/same-anchor-imperfection-review.js';

function candidate(id, {
    position = { x: 10, y: 20, width: 48, height: 48 },
    evidenceLoss = 0.1,
    damageLoss = 0.1,
    imperfectionScore = 1
} = {}) {
    return {
        hypothesis: { id, trial: { position } },
        result: { imageData: { width: 1, height: 1, data: new Uint8ClampedArray(4) } },
        qualitySignals: {
            evidenceLoss,
            damageLoss,
            residualLoss: imperfectionScore,
            imperfections: { score: imperfectionScore }
        }
    };
}

test('hasSameAnchor should compare structured x y width and height', () => {
    assert.equal(hasSameAnchor(candidate('a'), candidate('b')), true);
    assert.equal(hasSameAnchor(candidate('a'), candidate('b', {
        position: { x: 11, y: 20, width: 48, height: 48 }
    })), false);
    assert.deepEqual(getCandidatePosition(candidate('a')), { x: 10, y: 20, width: 48, height: 48 });
});

test('selectSameAnchorAlternative should choose the lowest imperfection candidate within diagnostic tolerances', () => {
    const selected = candidate('selected', { imperfectionScore: 1.4 });
    const expected = candidate('expected', {
        evidenceLoss: 0.15,
        damageLoss: 0.15,
        imperfectionScore: 0.5
    });
    const result = selectSameAnchorAlternative({
        selectedId: 'selected',
        completedCandidates: [
            selected,
            candidate('wrong-anchor', {
                position: { x: 12, y: 20, width: 48, height: 48 },
                imperfectionScore: 0.1
            }),
            candidate('too-much-damage', { damageLoss: 0.151, imperfectionScore: 0.2 }),
            expected,
            candidate('higher-score', { imperfectionScore: 0.8 })
        ]
    });

    assert.equal(result.selected.hypothesis.id, 'selected');
    assert.equal(result.alternative.hypothesis.id, 'expected');
    assert.equal(result.reason, 'matched');
});

test('selectSameAnchorAlternative should report why no comparison is available', () => {
    assert.equal(selectSameAnchorAlternative({
        selectedId: 'missing',
        completedCandidates: []
    }).reason, 'selected-not-captured');
    assert.equal(selectSameAnchorAlternative({
        selectedId: 'selected',
        completedCandidates: [candidate('selected')]
    }).reason, 'no-plausible-same-anchor-alternative');
});
```

- [ ] **Step 2: 运行测试确认 RED**

Run:

```powershell
node --test tests/scripts/sameAnchorImperfectionReview.test.js
```

Expected: FAIL，模块或导出尚不存在。

- [ ] **Step 3: 实现纯函数模块**

```js
export const DEFAULT_EVIDENCE_TOLERANCE = 0.05;
export const DEFAULT_DAMAGE_TOLERANCE = 0.05;

export function getCandidatePosition(candidate = {}) {
    return candidate.hypothesis?.trial?.position ??
        candidate.hypothesis?.position ??
        candidate.result?.meta?.position ??
        null;
}

export function hasSameAnchor(left, right) {
    const leftPosition = getCandidatePosition(left);
    const rightPosition = getCandidatePosition(right);
    if (!leftPosition || !rightPosition) return false;
    return leftPosition.x === rightPosition.x &&
        leftPosition.y === rightPosition.y &&
        leftPosition.width === rightPosition.width &&
        leftPosition.height === rightPosition.height;
}

function finiteOr(value, fallback) {
    return Number.isFinite(value) ? value : fallback;
}

export function selectSameAnchorAlternative({
    selectedId,
    completedCandidates = [],
    evidenceTolerance = DEFAULT_EVIDENCE_TOLERANCE,
    damageTolerance = DEFAULT_DAMAGE_TOLERANCE
} = {}) {
    const selected = completedCandidates.find((candidate) => candidate.hypothesis?.id === selectedId);
    if (!selected) {
        return { selected: null, alternative: null, reason: 'selected-not-captured' };
    }
    const selectedSignals = selected.qualitySignals ?? {};
    const selectedImperfection = finiteOr(selectedSignals.imperfections?.score, Infinity);
    const alternatives = completedCandidates.filter((candidate) => {
        if (candidate === selected || !hasSameAnchor(selected, candidate)) return false;
        const signals = candidate.qualitySignals ?? {};
        return finiteOr(signals.imperfections?.score, Infinity) < selectedImperfection &&
            finiteOr(signals.evidenceLoss, Infinity) <=
                finiteOr(selectedSignals.evidenceLoss, Infinity) + evidenceTolerance &&
            finiteOr(signals.damageLoss, Infinity) <=
                finiteOr(selectedSignals.damageLoss, Infinity) + damageTolerance;
    }).sort((left, right) =>
        finiteOr(left.qualitySignals?.imperfections?.score, Infinity) -
            finiteOr(right.qualitySignals?.imperfections?.score, Infinity) ||
        finiteOr(left.qualitySignals?.residualLoss, Infinity) -
            finiteOr(right.qualitySignals?.residualLoss, Infinity) ||
        String(left.hypothesis?.id ?? '').localeCompare(String(right.hypothesis?.id ?? ''))
    );
    if (alternatives.length === 0) {
        return { selected, alternative: null, reason: 'no-plausible-same-anchor-alternative' };
    }
    return { selected, alternative: alternatives[0], reason: 'matched' };
}
```

- [ ] **Step 4: 运行测试确认 GREEN**

Run:

```powershell
node --test tests/scripts/sameAnchorImperfectionReview.test.js
```

Expected: 3/3 通过。

---

### Task 3: 实现 residual-risk 重跑与三联图生成器

**Files:**
- Create: `scripts/run-same-anchor-imperfection-review.js`
- Test: `tests/scripts/runSameAnchorImperfectionReview.test.js`
- Generated: `.artifacts/same-anchor-imperfection-review/report.json`
- Generated: `.artifacts/same-anchor-imperfection-review/triplets/*.png`
- Generated: `.artifacts/same-anchor-imperfection-review/contact-sheet.png`
- Generated: `.artifacts/same-anchor-imperfection-review/review.json`

**Interfaces:**
- Consumes: `removeWatermarkFromImageDataSync(imageData, { debugTimings: true, onCandidateCompleted })` 与 Task 2 selector。
- Produces: `runSameAnchorImperfectionReview(options): Promise<ReviewReport>`、`renderTriplet(...)`、CLI 参数 `--report`、`--output-dir`。

- [ ] **Step 1: 写出 runner 的依赖注入测试**

测试使用临时目录、一个 tiny PNG 报告和注入的 `processImageData`，断言 runner：只处理 residual-risk、用回调捕获候选、验证结构化 anchor、写 report/triplet/review。

```js
test('runSameAnchorImperfectionReview should emit one matched triplet from residual-risk input', async (t) => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'gwr-imperfection-review-'));
    t.after(() => rm(tempRoot, { recursive: true, force: true }));
    const inputPath = path.join(tempRoot, 'input.png');
    await sharp({ create: { width: 32, height: 32, channels: 4, background: '#808080' } })
        .png().toFile(inputPath);
    const reportPath = path.join(tempRoot, 'combined-report.json');
    await writeFile(reportPath, JSON.stringify({
        generatedAt: '2026-07-16T00:00:00.000Z',
        results: [
            { fileName: 'input.png', input: inputPath, classification: 'residual-risk' },
            { fileName: 'ignored.png', input: inputPath, classification: 'applied-clean' }
        ]
    }));
    const makeCandidate = (id, score) => ({
        hypothesis: {
            id,
            family: 'alpha',
            trial: { position: { x: 8, y: 8, width: 16, height: 16 }, source: id }
        },
        result: { imageData: createImageData(32, 32, id === 'selected' ? 100 : 120), meta: {} },
        qualitySignals: {
            evidenceLoss: 0.1,
            residualLoss: score,
            damageLoss: 0.1,
            imperfections: { score, severity: 'high', types: ['spatial-residual'] }
        }
    });
    const result = await runSameAnchorImperfectionReview({
        reportPath,
        outputDir: path.join(tempRoot, 'out'),
        processImageData: (imageData, options) => {
            options.onCandidateCompleted(makeCandidate('selected', 1.2));
            options.onCandidateCompleted(makeCandidate('alternative', 0.4));
            return {
                imageData,
                meta: { selectedCandidate: { id: 'selected' } },
                debugTimings: { totalMs: 1 }
            };
        }
    });

    assert.equal(result.summary.residualRiskInputs, 1);
    assert.equal(result.summary.matched, 1);
    assert.equal(result.records[0].alternative.id, 'alternative');
    assert.equal(await exists(result.records[0].tripletPath), true);
    const review = JSON.parse(await readFile(path.join(tempRoot, 'out', 'review.json')));
    assert.equal(review.decisions[0].verdict, 'unclear');
});
```

测试文件同时定义本地 `createImageData()` 与 `exists()`，并从 runner 导入 `runSameAnchorImperfectionReview`。

- [ ] **Step 2: 运行测试确认 RED**

Run:

```powershell
node --test tests/scripts/runSameAnchorImperfectionReview.test.js
```

Expected: FAIL，runner 尚不存在。

- [ ] **Step 3: 实现 CLI 参数与无副作用 import guard**

runner 必须导出：

```js
export function parseArgs(argv = process.argv.slice(2)) {
    const getValue = (name, fallback) => {
        const index = argv.indexOf(name);
        return index >= 0 ? argv[index + 1] : fallback;
    };
    return {
        reportPath: path.resolve(getValue(
            '--report',
            '.artifacts/expanded-sample-validation/curated-top-n/combined-report.json'
        )),
        outputDir: path.resolve(getValue(
            '--output-dir',
            '.artifacts/same-anchor-imperfection-review'
        ))
    };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    runSameAnchorImperfectionReview(parseArgs()).catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}
```

- [ ] **Step 4: 实现图片解码、候选紧凑化和 triplet 渲染**

使用以下完整 helper 形状，确保 report 不持久化 ImageData：

```js
async function decodeImageData(filePath) {
    const { data, info } = await sharp(filePath, { limitInputPixels: false })
        .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return {
        width: info.width,
        height: info.height,
        data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength)
    };
}

function compactCandidate(candidate) {
    const hypothesis = candidate.hypothesis ?? {};
    const signals = candidate.qualitySignals ?? {};
    return {
        id: hypothesis.id ?? null,
        family: hypothesis.family ?? null,
        source: candidate.result?.meta?.source ?? hypothesis.trial?.source ?? null,
        position: getCandidatePosition(candidate),
        alphaProfile: hypothesis.alphaProfile ?? null,
        polarity: hypothesis.polarity ?? null,
        qualityStatus: signals.qualityStatus ?? null,
        losses: {
            evidence: signals.evidenceLoss ?? null,
            residual: signals.residualLoss ?? null,
            damage: signals.damageLoss ?? null
        },
        imperfections: signals.imperfections ?? null,
        final: signals.final ?? null,
        artifacts: signals.artifacts ? {
            visualArtifactCost: signals.artifacts.visualArtifactCost ?? null,
            newlyClippedRatio: signals.artifacts.newlyClippedRatio ?? null,
            halo: signals.artifacts.halo ?? null
        } : null
    };
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
```

增加完整的像素编码与 triplet 渲染函数：

```js
function imageDataSharp(imageData) {
    return sharp(Buffer.from(
        imageData.data.buffer,
        imageData.data.byteOffset,
        imageData.data.byteLength
    ), {
        raw: {
            width: imageData.width,
            height: imageData.height,
            channels: 4
        }
    });
}

export async function renderTriplet({
    sourcePath,
    selectedImageData,
    alternativeImageData,
    position,
    outputPath,
    scale = 4
}) {
    const crop = createCrop(position, selectedImageData);
    const tileWidth = crop.width * scale;
    const tileHeight = crop.height * scale;
    const sourceTile = await sharp(sourcePath, { limitInputPixels: false })
        .extract(crop).resize(tileWidth, tileHeight, { kernel: 'nearest' }).png().toBuffer();
    const selectedTile = await imageDataSharp(selectedImageData)
        .extract(crop).resize(tileWidth, tileHeight, { kernel: 'nearest' }).png().toBuffer();
    const alternativeTile = await imageDataSharp(alternativeImageData)
        .extract(crop).resize(tileWidth, tileHeight, { kernel: 'nearest' }).png().toBuffer();
    await mkdir(path.dirname(outputPath), { recursive: true });
    await sharp({
        create: {
            width: tileWidth * 3,
            height: tileHeight,
            channels: 4,
            background: { r: 0, g: 0, b: 0, alpha: 1 }
        }
    }).composite([sourceTile, selectedTile, alternativeTile].map((input, index) => ({
        input,
        left: index * tileWidth,
        top: 0
    }))).png().toFile(outputPath);
    return outputPath;
}
```

- [ ] **Step 5: 实现主循环**

主循环必须遵循：

```js
const sourceReport = JSON.parse(await readFile(reportPath, 'utf8'));
const residualRiskInputs = sourceReport.results.filter(
    (record) => record.classification === 'residual-risk'
);
for (const sourceRecord of residualRiskInputs) {
    const originalImageData = await decodeImageData(sourceRecord.input);
    const completedCandidates = [];
    const result = processImageData(originalImageData, {
        adaptiveMode: 'auto',
        debugTimings: true,
        onCandidateCompleted: (candidate) => completedCandidates.push(candidate)
    });
    const match = selectSameAnchorAlternative({
        selectedId: result.meta?.selectedCandidate?.id,
        completedCandidates
    });
    if (match.reason !== 'matched') {
        records.push({
            fileName: sourceRecord.fileName,
            input: sourceRecord.input,
            status: 'not-reproduced',
            reason: match.reason
        });
        continue;
    }
    const selectedPosition = getCandidatePosition(match.selected);
    if (!hasSameAnchor(match.selected, match.alternative)) {
        throw new Error(`Structured anchor mismatch: ${sourceRecord.fileName}`);
    }
    const tripletPath = await renderTriplet({
        sourcePath: sourceRecord.input,
        selectedImageData: match.selected.result.imageData,
        alternativeImageData: match.alternative.result.imageData,
        position: selectedPosition,
        outputPath: path.join(outputDir, 'triplets', `${path.parse(sourceRecord.fileName).name}.png`)
    });
    records.push({
        fileName: sourceRecord.fileName,
        input: sourceRecord.input,
        status: 'matched',
        selected: compactCandidate(match.selected),
        alternative: compactCandidate(match.alternative),
        tripletPath,
        processingMs: result.debugTimings?.totalMs ?? null
    });
}
```

- [ ] **Step 6: 实现 report、review template 与 contact sheet**

`report.json` 包含 SHA-256：

```js
const sourceReportSha256 = createHash('sha256')
    .update(await readFile(reportPath))
    .digest('hex');
```

`review.json` 仅包含 matched records：

```js
{
    sourceReportSha256,
    decisions: matchedRecords.map((record) => ({
        fileName: record.fileName,
        verdict: 'unclear',
        reason: ''
    }))
}
```

contact sheet 按 `selected.position.width`、`selected.position.x`、文件名排序，并使用完整 helper：

```js
function escapeXml(value) {
    return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&apos;');
}

export async function renderContactSheet({ records, outputPath }) {
    const ordered = [...records].sort((left, right) =>
        left.selected.position.width - right.selected.position.width ||
        left.selected.position.x - right.selected.position.x ||
        left.fileName.localeCompare(right.fileName)
    );
    const columns = 2;
    const tileWidth = 900;
    const imageHeight = 320;
    const labelHeight = 24;
    const gap = 8;
    const tileHeight = labelHeight + imageHeight;
    const tiles = [];
    for (const [index, record] of ordered.entries()) {
        const image = await sharp(record.tripletPath)
            .resize(tileWidth, imageHeight, {
                fit: 'contain',
                background: { r: 0, g: 0, b: 0, alpha: 1 }
            }).png().toBuffer();
        const label = Buffer.from(
            `<svg width="${tileWidth}" height="${labelHeight}">` +
            `<rect width="100%" height="100%" fill="#111"/>` +
            `<text x="8" y="17" fill="#fff" font-size="13" font-family="sans-serif">` +
            `${escapeXml(record.fileName)} | ${record.selected.position.width}px` +
            `</text></svg>`
        );
        const tile = await sharp({
            create: {
                width: tileWidth,
                height: tileHeight,
                channels: 4,
                background: { r: 0, g: 0, b: 0, alpha: 1 }
            }
        }).composite([
            { input: label, left: 0, top: 0 },
            { input: image, left: 0, top: labelHeight }
        ]).png().toBuffer();
        tiles.push({
            input: tile,
            left: (index % columns) * (tileWidth + gap),
            top: Math.floor(index / columns) * (tileHeight + gap)
        });
    }
    const rows = Math.ceil(Math.max(1, ordered.length) / columns);
    await sharp({
        create: {
            width: columns * tileWidth + (columns - 1) * gap,
            height: rows * tileHeight + (rows - 1) * gap,
            channels: 4,
            background: { r: 28, g: 28, b: 28, alpha: 1 }
        }
    }).composite(tiles).png().toFile(outputPath);
    return outputPath;
}
```

- [ ] **Step 7: 运行测试确认 GREEN**

Run:

```powershell
node --test tests/scripts/runSameAnchorImperfectionReview.test.js tests/scripts/sameAnchorImperfectionReview.test.js
```

Expected: 全部通过，临时输出包含 report、triplet、review。

---

### Task 4: 实现人工复核汇总器

**Files:**
- Create: `scripts/summarize-same-anchor-imperfection-review.js`
- Test: `tests/scripts/summarizeSameAnchorImperfectionReview.test.js`
- Modify: `package.json`
- Modify: `tests/scripts/scriptEntrypoints.test.js`
- Generated: `.artifacts/same-anchor-imperfection-review/summary.json`

**Interfaces:**
- Consumes: `report.json` 与 `review.json`。
- Produces: `summarizeReview({ report, review }): Summary` 和 CLI `--root`。

- [ ] **Step 1: 写出判定完整性与聚合测试**

```js
test('summarizeReview should validate decisions and aggregate geometry and verdicts', () => {
    const report = {
        sourceReportSha256: 'abc',
        records: [
            {
                fileName: 'a.png', status: 'matched',
                selected: { family: 'standard', position: { width: 48 }, imperfections: { types: ['spatial-residual'] } },
                alternative: { family: 'alpha', imperfections: { score: 0.4 } }
            },
            {
                fileName: 'b.png', status: 'matched',
                selected: { family: 'alpha', position: { width: 96 }, imperfections: { types: ['gradient-residual'] } },
                alternative: { family: 'alpha', imperfections: { score: 0.7 } }
            }
        ]
    };
    const review = {
        sourceReportSha256: 'abc',
        decisions: [
            { fileName: 'a.png', verdict: 'alternative-better', reason: 'dark body is weaker' },
            { fileName: 'b.png', verdict: 'current-better', reason: 'alternative adds a bright edge' }
        ]
    };

    const summary = summarizeReview({ report, review });

    assert.deepEqual(summary.verdicts, {
        'alternative-better': 1,
        tie: 0,
        'current-better': 1,
        unclear: 0
    });
    assert.equal(summary.byWidth['48']['alternative-better'], 1);
    assert.equal(summary.byFamilyTransition['standard>alpha']['alternative-better'], 1);
});

test('summarizeReview should reject stale or incomplete review files', () => {
    assert.throws(() => summarizeReview({
        report: { sourceReportSha256: 'new', records: [] },
        review: { sourceReportSha256: 'old', decisions: [] }
    }), /hash mismatch/);
});
```

- [ ] **Step 2: 运行测试确认 RED**

Run:

```powershell
node --test tests/scripts/summarizeSameAnchorImperfectionReview.test.js
```

Expected: FAIL，汇总器尚不存在。

- [ ] **Step 3: 实现严格汇总器**

允许 verdict 集合固定为：

```js
const ALLOWED_VERDICTS = new Set([
    'alternative-better',
    'tie',
    'current-better',
    'unclear'
]);
```

`summarizeReview` 必须：

1. 校验 report/review hash 一致；
2. matched record 每张恰好一个 decision；
3. 拒绝未知文件、重复文件和非法 verdict；
4. 输出 `verdicts`、`byWidth`、`byFamilyTransition`、`bySelectedImperfectionType`；
5. 输出 `requiresSeparateProductionDesign: true`，明确诊断结论不能自动修改生产代码。

实现为：

```js
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ALLOWED_VERDICTS = new Set([
    'alternative-better',
    'tie',
    'current-better',
    'unclear'
]);

function emptyVerdicts() {
    return {
        'alternative-better': 0,
        tie: 0,
        'current-better': 0,
        unclear: 0
    };
}

function incrementGroup(groups, key, verdict) {
    if (!groups[key]) groups[key] = emptyVerdicts();
    groups[key][verdict]++;
}

export function summarizeReview({ report, review }) {
    if (report.sourceReportSha256 !== review.sourceReportSha256) {
        throw new Error('review/report hash mismatch');
    }
    const matched = report.records.filter((record) => record.status === 'matched');
    const decisionByFile = new Map();
    for (const decision of review.decisions ?? []) {
        if (decisionByFile.has(decision.fileName)) {
            throw new Error(`duplicate review decision: ${decision.fileName}`);
        }
        if (!ALLOWED_VERDICTS.has(decision.verdict)) {
            throw new Error(`invalid review verdict: ${decision.verdict}`);
        }
        decisionByFile.set(decision.fileName, decision);
    }
    const matchedFiles = new Set(matched.map((record) => record.fileName));
    for (const fileName of decisionByFile.keys()) {
        if (!matchedFiles.has(fileName)) throw new Error(`unknown review file: ${fileName}`);
    }

    const verdicts = emptyVerdicts();
    const byWidth = {};
    const byFamilyTransition = {};
    const bySelectedImperfectionType = {};
    for (const record of matched) {
        const decision = decisionByFile.get(record.fileName);
        if (!decision) throw new Error(`missing review decision: ${record.fileName}`);
        verdicts[decision.verdict]++;
        incrementGroup(byWidth, String(record.selected.position.width), decision.verdict);
        incrementGroup(
            byFamilyTransition,
            `${record.selected.family}>${record.alternative.family}`,
            decision.verdict
        );
        const typeKey = record.selected.imperfections?.types?.join('+') || 'none';
        incrementGroup(bySelectedImperfectionType, typeKey, decision.verdict);
    }
    return {
        matched: matched.length,
        verdicts,
        byWidth,
        byFamilyTransition,
        bySelectedImperfectionType,
        requiresSeparateProductionDesign: true
    };
}

export async function runSummary({ root }) {
    const report = JSON.parse(await readFile(path.join(root, 'report.json'), 'utf8'));
    const review = JSON.parse(await readFile(path.join(root, 'review.json'), 'utf8'));
    const summary = summarizeReview({ report, review });
    const outputPath = path.join(root, 'summary.json');
    await writeFile(outputPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    return { summary, outputPath };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const argv = process.argv.slice(2);
    const rootIndex = argv.indexOf('--root');
    const root = path.resolve(rootIndex >= 0
        ? argv[rootIndex + 1]
        : '.artifacts/same-anchor-imperfection-review');
    runSummary({ root }).then(({ outputPath }) => {
        console.log(outputPath);
    }).catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}
```

CLI 读取 `--root`（默认 `.artifacts/same-anchor-imperfection-review`）并写 `summary.json`。

同时在 `package.json` 增加：

```json
"diagnose:same-anchor-imperfection": "node scripts/run-same-anchor-imperfection-review.js",
"report:same-anchor-imperfection": "node scripts/summarize-same-anchor-imperfection-review.js"
```

在 `tests/scripts/scriptEntrypoints.test.js` 的 `expectedScripts` 增加：

```js
'diagnose:same-anchor-imperfection': 'node scripts/run-same-anchor-imperfection-review.js',
'report:same-anchor-imperfection': 'node scripts/summarize-same-anchor-imperfection-review.js'
```

- [ ] **Step 4: 运行测试确认 GREEN**

Run:

```powershell
node --test tests/scripts/summarizeSameAnchorImperfectionReview.test.js tests/scripts/scriptEntrypoints.test.js
```

Expected: 全部通过。

---

### Task 5: 运行 111 张诊断、完成 26 张视觉复核并验证无生产回归

**Files:**
- Generated: `.artifacts/same-anchor-imperfection-review/report.json`
- Generated: `.artifacts/same-anchor-imperfection-review/contact-sheet.png`
- Generated: `.artifacts/same-anchor-imperfection-review/review.json`
- Generated: `.artifacts/same-anchor-imperfection-review/summary.json`
- Compare: `.artifacts/expanded-sample-validation/curated-top-n/combined-report.json`

**Interfaces:**
- Consumes: Tasks 1-4 的 callback、selector、runner、summarizer。
- Produces: 经人工视觉标注的诊断证据；不产生生产排序改动。

- [ ] **Step 1: 运行当前报告的 residual-risk 诊断**

Run:

```powershell
pnpm diagnose:same-anchor-imperfection
```

Expected:

- `residualRiskInputs = 111`；
- 预计 `matched = 26`，若不是 26，报告 `not-reproduced` 原因并使用实际数量；
- 每个 matched record 的 selected ID 与当前生产结果一致；
- 所有 alternative 与 selected 结构化 anchor 相同。

- [ ] **Step 2: 检查 contact sheet 与逐张 triplet**

先查看 `contact-sheet.png`，再逐张查看 `triplets/*.png`。每张按以下顺序检查：

1. 星形主体是否更弱；
2. 四个尖角是否出现亮边或暗边；
3. alpha 边缘是否形成环状 halo；
4. 是否制造黑洞、白块或 clipped 像素；
5. 邻近真实线条、文字、人物或纹理是否被误处理；
6. 正常观看尺度是否真的能区分。

- [ ] **Step 3: 填写 review.json**

只允许：

```json
{
  "fileName": "example.png",
  "verdict": "alternative-better",
  "reason": "主体暗残影更弱，未增加亮边或内容损伤"
}
```

若无法确定，使用 `unclear`；不得以指标更低代替视觉判断。

- [ ] **Step 4: 生成汇总并读取决策门**

Run:

```powershell
pnpm report:same-anchor-imperfection
```

Expected: `summary.json` 的 verdict 总数等于 matched 数量；按 width、family transition、imperfection type 给出胜负分布。

- [ ] **Step 5: 复跑聚焦测试、完整测试和构建**

Run:

```powershell
node --test tests/core/imageWatermarkPipeline.test.js tests/scripts/sameAnchorImperfectionReview.test.js tests/scripts/runSameAnchorImperfectionReview.test.js tests/scripts/summarizeSameAnchorImperfectionReview.test.js tests/scripts/scriptEntrypoints.test.js
pnpm test
pnpm build
git diff --check
```

Expected:

- 聚焦测试全部通过；
- 完整测试 0 fail；
- 生产构建成功；
- 未启用 callback 的 36/424 生产结果不因本轮诊断代码改变。

- [ ] **Step 6: 审计工作区并交付，不自动提交重叠文件**

Run:

```powershell
git status --short
git diff -- src/core/imageWatermarkPipeline.js tests/core/imageWatermarkPipeline.test.js
git diff --check -- scripts/same-anchor-imperfection-review.js scripts/run-same-anchor-imperfection-review.js scripts/summarize-same-anchor-imperfection-review.js tests/scripts/sameAnchorImperfectionReview.test.js tests/scripts/runSameAnchorImperfectionReview.test.js tests/scripts/summarizeSameAnchorImperfectionReview.test.js
```

Expected: 交付说明明确列出本轮新增/修改文件、诊断样本实际数量、视觉 verdict 分布、产物路径和下一轮建议；由于已有脏工作区，不执行自动提交。
