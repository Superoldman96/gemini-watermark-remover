# 同 Anchor Clean 严格支配排序设计

## 背景

最新 424 张样本的 top-N 报告显示，当前候选排序同时考虑三项最终质量损失和候选发现角色：

- evidence loss 权重为 `0.35`；
- residual loss 权重为 `0.40`；
- damage loss 权重为 `0.25`；
- `conservative-derived` 候选额外增加 `0.15` discovery penalty。

discovery penalty 用于防止较晚生成的 alpha 派生候选轻易替换固定候选，这一先验在质量相近时有价值。但当前 Pareto dominance 也把 discovery penalty 当作支配条件，因此同一个位置和尺寸的派生候选即使 evidence、residual、damage 三项都不差，仍可能因 `0.15` 先验落后。

报告中有 6 张样本满足以下事实：

- 当前第一名不是 `clean`；
- top-N 内存在相同 `x/y/width/height` 的 `clean` 候选；
- clean 候选的 evidence、residual、damage 三项 loss 均不高于当前第一名，至少一项更低；
- 其较高 final score 可以由 discovery penalty 解释。

按报告静态模拟，这 6 张分别对应 5 个 `visible-residual → clean` 和 1 个 `possible-content-damage → clean`。全局忽略 discovery penalty 会改变 121/424，并出现 `clean → visible-residual`，因此不采用。

## 目标

- 当相同 anchor 的 clean 候选在三项质量 loss 上严格支配非 clean 候选时，允许 clean 候选越过 discovery penalty。
- 保持 fixed candidate 对质量相近或同为 clean 的 conservative-derived 候选的现有优先级。
- 不扩大到跨位置、跨尺寸候选，防止空白错误 anchor 依靠低残留获胜。
- 不改变最大化处理、best-effort 输出和瑕疵信号反馈策略。

## 方案比较

### 方案 A：同 Anchor Clean 严格支配覆盖（采用）

在最终候选比较中，先判断一个 clean 候选是否在相同 anchor 上严格支配非 clean 候选。满足时直接优先 clean 候选；不满足时继续执行现有 catastrophic block、discovery penalty、final score 和 ranking key 规则。

优点是边界可解释，预计只影响 6/424；缺点是增加一条状态感知的比较规则。

### 方案 B：降低或移除 `conservative-derived` penalty

会影响约 121/424，并可能把已有 clean 结果改成 visible residual，不采用。

### 方案 C：新增暗背景 alpha 模型

可能改善没有 clean 备选的暗背景样本，但不能解释“已有严格更优候选却未选中”的排序错误。本轮不采用，待排序修复后重新评估剩余簇。

## 设计

### Anchor 等价

两个候选只有在以下最终 trial 几何完全相同时才属于相同 anchor：

- `position.x`；
- `position.y`；
- `position.width`；
- `position.height`。

不得使用候选 ID 字符串解析 anchor。比较函数直接读取 hypothesis trial 或 position 中的结构化坐标。

### Clean 严格支配

候选 `left` 只有同时满足以下条件，才能对 `right` 触发覆盖：

1. `left.qualitySignals.qualityStatus === 'clean'`；
2. `right.qualitySignals.qualityStatus !== 'clean'`；
3. 两者 anchor 完全相同；
4. `left.evidenceLoss <= right.evidenceLoss`；
5. `left.residualLoss <= right.residualLoss`；
6. `left.damageLoss <= right.damageLoss`；
7. 三项 loss 至少一项严格更低。

这一判断不使用 discovery penalty。它表达的是：相同定位下，后生成候选已经同时改善或保持了所有观测质量维度，并跨越到 clean 状态。

### 排序顺序

排序保持以下优先级：

1. 现有 catastrophic block 规则继续最高优先，灾难性块不得因 clean 标签被选中；
2. 应用同 anchor clean 严格支配覆盖；
3. 应用现有包含 discovery penalty 的 dominated 标记；
4. 比较现有 final score；
5. 使用 ranking key 和候选 ID 确定稳定顺序。

clean 覆盖必须是对称比较：如果 `left` 覆盖 `right`，返回 left 优先；如果 `right` 覆盖 `left`，返回 right 优先。两个候选都 clean、都非 clean、anchor 不同或三项 loss 存在取舍时，不触发覆盖。

### 数据流

completed candidates → 现有 quality signals → 现有 discovery penalty/final score → 候选比较器先检查 catastrophic block → 检查同 anchor clean 严格支配 → 回落到现有排序 → 输出 top-N 和选中结果。

不修改候选生成、图片处理、alpha gain、修复阶段或元数据格式。

## 测试与验收

### 单元测试

1. 相同 anchor 的 clean conservative-derived 候选在三项 loss 严格支配 visible fixed candidate 时获胜。
2. 相同 anchor 的 clean conservative-derived 候选在三项 loss 严格支配 damage fixed candidate 时获胜。
3. 两个候选都 clean 时，继续保留 fixed candidate 优先级。
4. clean 候选来自不同 anchor 时，不绕过 discovery penalty。
5. clean 候选任一 loss 更差时，不触发覆盖。
6. catastrophic block 仍不能获胜。

### 样本验收

1. 对静态模拟识别的 6 张样本分别生成修改前后输出并进行裁剪肉眼核验。
2. 只有视觉结果确实改善的样本才计入成功，不以 `qualityStatus` 标签变化替代肉眼核验。
3. 预期候选选择变化范围为 6/424；若超过 6，暂停并检查 anchor 或比较条件。
4. 36 样本保持灾难性块 `0`、retry `0`、干净恢复至少 `15/16`。
5. 424 样本保持 errors `0`、catastrophic blocks `0`、retry `0`，且不得出现原 clean 样本退化为非 clean。
6. 全量自动测试与生产构建通过。

## 瑕疵与错误反馈

本设计不隐藏或重写质量信号。若没有满足严格条件的 clean 候选，继续选择现有 top-1 并暴露 `visible-residual`、`possible-content-damage` 或 `mixed`。这保证用户仍能看到处理瑕疵，而不是被动跳过或无意义重试。

### 定点视觉验收后的修订

6 张三联图（原图、当前输出、候选输出）表明，候选输出在 1、2、3、6 上减轻了深色星形残影，5 基本持平；4 将较强的深色实体/梯度残影转换为较弱但仍可见的亮色边缘残影。现有 `qualityStatus` 只有超过硬可见阈值才标记 residual，因此第 4 张虽然整体残留降低，却被粗略标成 `clean`，无法表达残留类型转换。

因此增加一个不参与 fail-closed、retry 或是否处理决策的底层 `imperfections` 信号：

- 沿用现有 spatial `0.18`、gradient `0.22`、positive halo luminance `6` 三个硬可见阈值；
- 每项输出原始值、硬阈值和 `value / threshold` 比率；
- 最大比率形成连续 `score`；
- `score >= 1` 为 `high`，`0.5 <= score < 1` 为 `moderate`，`0 < score < 0.5` 为 `low`，其余为 `none`；
- `types` 列出达到 `0.5` 预警比率的 spatial、gradient、positive-halo 类型；
- `detected` 只表示达到中等瑕疵预警，不阻止最佳候选输出。

这一修订保留最大化处理和 top-N 选优，同时把未达到旧硬阈值的亮边、暗洞或结构残留如实交给调用层。样本验收不再把 `qualityStatus === clean` 等同于完全无瑕疵，而是同时比较 `imperfections.score/severity/types` 和三联图。

## 非目标

- 不全局调低 discovery penalty。
- 不修改 evidence、residual、damage 权重。
- 不新增安全跳过或 fail-closed 条件。
- 不改变候选生成数量或 family。
- 不开发暗背景 alpha/profile 修复。
- 不处理不同 anchor 之间的 clean 候选迁移。
