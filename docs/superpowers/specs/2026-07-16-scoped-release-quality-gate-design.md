# Scoped Release Quality Gate Design

## 目标

让发布门按照本次版本实际改变和声明的能力判定，而不是要求每次发布都重新具备所有历史研究产物。

`v1.0.30` 的发布范围是图像水印处理：小尺寸强证据候选、`96x96` 明暗轮廓模板、同锚点 Top-N 选择、轮廓修复和瑕疵信号。视频生产默认值相对 `v1.0.29` 没有变化；视频去噪、视频 alpha-shape、Allenk 视频对等和广泛 V2 覆盖仍是实验或受限声明。

设计必须同时满足：

- 当前图像实现仍需通过可审计的发布证据；
- 缺失的旧视频研究目录不能阻塞纯图像版本；
- 没有证据的能力不能被发布说明宣传；
- 相关实现文件变化后，旧的图像证据必须自动失效；
- 不降低现有构建、完整测试、SDK smoke、发布包和 GitHub CI 门槛。

## 当前问题

当前 `release:quality-gate` 首先以 `--fail-on-incomplete` 运行 Allenk V2 对比，再运行 release readiness。Allenk 对比的“完成”状态同时要求：

- 历史 36px/V2 图像 summary；
- Allenk 本地仓库；
- 视频 crop benchmark；
- 视频 denoise gate；
- 视频 alpha-shape gate 及渲染输出。

这些输入都位于被忽略的 `.artifacts`，GitHub Actions 不会生成或上传它们。当前工作区缺失这些历史文件，因此 gate 失败；失败并不是当前图像样本或自动测试发现了回归。

`v1.0.29..HEAD` 之间没有视频源码或视频测试文件变化。把历史视频研究完整性作为 `v1.0.30` 图像发布的前置条件，与本次风险范围不一致。

## 方案比较

### 方案一：恢复全部历史产物后维持现状

优点是无需修改门槛语义。缺点是产物无法从 CI 恢复，重新生成需要旧样本、旧视频、渲染输出和多个人工判断；即使恢复，也会在下次清理 `.artifacts` 后再次阻塞。

### 方案二：直接让缺失证据变成 warning

实现最少，但会让真正改变视频默认值或宣称广泛 V2 支持的版本也可能通过。它把“发布范围不相关”和“证据缺失”混为一谈，因此不采用。

### 方案三：按发布范围分离能力门与声明门（采用）

本次版本只把图像生产默认能力列为发布能力。图像能力必须有固定、可校验的 v1.0.30 证据；Allenk/V2 和视频 lane 继续生成状态并约束公开声明，但只有版本明确改变或声明这些能力时才阻止发布。

这个方案保留 fail-closed，只缩小到本次真正发布的能力。

## 发布范围

`v1.0.30` 使用 `image-defaults` 范围，含义固定为：

- 发布当前图像处理实现和 SDK 图像元数据；
- 允许有限声明“小尺寸强证据候选和新版轮廓变体兼容性改善”；
- 禁止声明广泛 V2 覆盖；
- 禁止声明 Allenk 视频效果对等；
- 禁止把视频 denoise 或 alpha-shape 实验候选描述为新默认值；
- 视频现有生产默认值必须保持安全且没有相对 `v1.0.29` 的源码变化。

范围只影响哪些能力可以阻止发布，不会从构建或发布包中删除已有视频功能。

## 固定图像发布证据

新增一份提交到仓库的紧凑证据文件：

`release/evidence/v1.0.30-image-quality.json`

它从本轮真实生成的报告汇总，不复制图片或大体积中间产物。至少记录：

- schema、版本和生成时间；
- 相关生产源码文件及其 SHA-256；
- 使用的样本 manifest/report SHA-256；
- 36 张 contrast 结果；
- 424 张近期样本最终结果与前后候选差异；
- 10 张 exact-96 同锚点人工复核的 `7 better / 3 tie / 0 worse`；
- error、catastrophic、retry 和新增 clean regression 数量；
- 完整测试、SDK smoke、build 和 extension package 结果；
- 发布包版本、大小和 SHA-256。

证据生成器只读取现存报告和文件并计算摘要与 hash，不允许从设计文档或 changelog 反推测试数据。任何必要输入缺失时生成失败。

图像 gate 校验证据版本、必需字段、阈值、源码 hash 和发布包 hash。相关源码、测试脚本、版本或发布包发生变化后，旧证据必须失败，要求重新运行相应验证并生成新证据。

## Gate 架构

### 图像发布 gate

新增独立的 `release:image-quality-gate`，负责校验：

- v1.0.30 固定图像证据存在且 provenance 与当前树一致；
- 36 张 contrast 无 catastrophic、retry 或原 clean 退化；
- 424 张近期样本无 error、catastrophic、retry 和范围外定位/状态变化；
- 人工复核没有 `current-better` 或 `unclear`；
- 完整测试、SDK smoke、build 和发布包结果全部成功；
- extension zip、checksum 和 `latest-extension.json` 完全一致。

### Allenk/V2 对比 gate

`compare:allenk-v2` 仍生成报告和 blocked claims，但在 `image-defaults` 范围下不使用 `--fail-on-incomplete`。它继续阻止以下声明：

- broad image V2 coverage；
- video V2 Allenk parity；
- 新视频 denoise 默认值；
- 新视频 alpha-shape 默认值。

未来某个版本若要发布其中任一能力，必须显式选择相应范围，并恢复或重跑对应证据；不能依靠 `image-defaults` 范围绕过。

### Release readiness

readiness 继续报告全部 lane，但 `image-defaults` 的立即发布条件只包含：

- release artifact；
- release claims scan；
- userscript artifact；
- release version/docs；
- image quality evidence；
- video production defaults safe and unchanged。

实验视频 lane 和广泛 V2 lane 继续显示 blocked/experiment-only，并进入 forbidden claim 列表，但不再把当前图像能力变成 `not-ready-for-release`。

### Preflight 与 CI

`release:preflight` 保留现有 build、完整测试、extension 打包、goal audit 和当前 HEAD GitHub CI 检查。质量门顺序调整为：

1. 校验固定图像证据；
2. 生成 Allenk/V2 状态与声明限制；
3. 运行 scoped release readiness；
4. 运行 release goal audit；
5. 校验当前 HEAD CI。

CI 不需要访问用户本地样本目录；它验证已提交证据的源码 hash，并重新运行 build、SDK smoke 和完整测试。发布前的外部样本运行仍在本地完成，其结果通过固定证据进入提交。

## 失败处理

- 固定证据缺失、JSON 无效或 schema 不支持：失败。
- 相关源码或发布包 hash 不一致：失败，并提示重新生成证据。
- 图像 acceptance 任一项越界：失败，输出具体指标。
- Allenk/V2 或实验视频证据缺失：保持相关声明 blocked；在 `image-defaults` 范围不阻止发布。
- 检测到视频生产默认源码相对 v1.0.29 有变化：失败，要求切换到包含视频验证的范围。
- changelog/README 出现受禁止的广泛 V2 或视频能力声明：失败。
- 当前 HEAD 没有成功 GitHub CI：现有 `release:ci-check` 继续 fail-closed。

## 测试策略

### 单元测试

- 固定证据全部匹配时图像 gate 通过；
- 任一源码、报告、版本或 zip hash 变化时失败；
- acceptance 边界和超界分别通过/失败；
- 缺失和非法证据失败；
- `image-defaults` 下实验视频 lane 缺失只阻止声明；
- 视频默认源码变化仍阻止发布；
- 禁止声明扫描保持 fail-closed。

### 集成测试

- 用临时 fixture 运行 evidence generator、image gate 和 scoped readiness；
- 证明旧的全局 Allenk gate 缺失不会阻塞合法的 image-only RC；
- 证明显式请求 broad V2 或 video capability 时，同样的缺失证据会阻塞；
- 证明 `release:goal-audit` 识别新的命令契约。

### v1.0.30 验收

- 从本轮现存的 36/424/same-anchor 报告生成固定证据；
- 重新运行完整测试、SDK smoke、build 和 extension package；
- `release:image-quality-gate` 通过；
- scoped `release:quality-gate` 通过；
- 发布说明只包含已验证的图像改进；
- 提交并推送后，当前 HEAD GitHub CI 成功；
- 最终 `release:preflight` 全部通过后才创建 tag 和 GitHub Release。

## 非目标

- 不修改图像水印算法、候选排序或现有测试阈值；
- 不启用任何新视频默认后端；
- 不重建历史视频研究；
- 不宣称广泛 V2 或 Allenk 视频对等；
- 不自动发布 npm、Chrome Web Store 或网站，发布动作仍在所有 gate 通过后单独执行。
