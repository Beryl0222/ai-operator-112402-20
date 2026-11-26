# 离线蒙版扩散的条件噪声张量与跨步复现

这里的扩散网格、白噪声身份和条件块是用于设备联调的合成资料。使用 Node.js 22。运行 `npm ci --offline` 核对依赖锁，`npm run inspect` 查看资料字段，`npm test` 检查资料格式及相互引用。检视脚本只读取元数据。

## 数据格式

模型是 z = D*ε + U*η，D 是逐格非负对角，U 的每列是跨尺度的共享特征；两组标准正态 ε、η 独立。条件为稀疏线性 C z=b，同一步 stamp 内可同时多行，支持相关及秩亏。读数的数学参考是给定义联合高斯的正交条件化，条件满足容差为 3e-6；一致性退化判定以 covarianceTol 为准。原生噪声按 noise-key.mjs 所述 SHA-256 身份与 Box–Muller 解释，以 ε/η 的独立身份出数。协方差抽样须与同种子确定的未条件噪声保持其相对作用，允许数值等价的正交消去。条件更新后的报表要记录模型和约束身份，不冻结整个网格。工作区内不允许把典型 N×N 矩阵落盘，在一次局部读取中按 latentFetch 统计原生潜变量实际取数。 典型请求支持 8 个 conditionTile 与小例条件一起启用。相邻 tile 不共享索引，4 个小例条件包含近依存情况。ε/η 的 Box–Muller 输入取 SHA-256 最前四、第二四字节的无符号大端值加 0.5 后除 2^32，key 为 JSON UTF-8 的 [seed,step,component,index]。设备只读标准态的相同坐标，变更条件时可重用原生随机量，但不能把先前已经过条件化的结果视为独立原生量。 接受操作的目标若已在有效条件集，引用实际斑块与条件身份，不能将另一个步次中名称恰好相同的条件移至当前。

## 取数

`inputs/noise-key.json` 保存标定、规格和调用记录。记录中的范围除明确说明外从零开始，使用半开区间。批量数组按调用记录列出的顺序交付。noiseRow(index,basis) 给对角噪声系数与低秩行，noiseNormal(step,component,index) 给原生随机变量，conditionTile(tile) 读条件块。

## 条件噪声 API

主入口是 `index.mjs`（也可从 `conditional-noise.mjs`、`operator.mjs`、`editor.mjs`、`solution.mjs` 等兼容文件名导入）。

```js
import { sampleConditional, createEditor } from './index.mjs';

const noise = sampleConditional({
  stamp: 'a',                 // 关联 [stamp, step, basis]
  conditions: ['bound', 'same', 'low'], // 也接受 [id, indices, weights, b] 或对象
  region: [128, 256],         // 半开区间、索引数组或 {start,end}
  // seed: 'example-seed',    // 不传则用 noise-key.json 的 seed
});

noise.values;          // 按请求索引顺序交付的条件噪声 z
noise.maxResidual;     // 全部原始条件的最大残差，要求 < 3e-6
noise.rank;            // 相容条件的独立秩；重复行不增加秩
noise.latentFetch;     // 实际读取的唯一原生 ε/η 坐标数
noise.budget;          // 取数、留存字节和 workBytes/latentFetch 预算
```

数学实现直接在原生标准坐标 `x=[ε,η]` 上做正交条件化：`z=Hx`、`G=CH`，并用 `x'=x+Gᵀ(GGᵀ)⁺(b-Gx)` 的等价正交消去。典型 tile 的 `GGᵀ` 具有“稀疏 ε 重叠块 + rank 36 低秩项”结构，因此走分块 Cholesky + Woodbury；只有出现零对角/秩亏复杂重叠时才进入小规模稠密正交行消去。不会构造或落盘典型的 N×N 协方差矩阵。

### 编辑器与历史

```js
const editor = createEditor();
const run = editor.runView();      // 按 noise-key.json 的 view 顺序回放

const preview = editor.sample('a', [0, 64], { seed: 'example' });
editor.acceptVersion('a', preview.versionId, { indices: [0, 1, 8] });
editor.request('a', [128, 256]);   // 沿用 a/T18/basis1、条件和示例种子
editor.readVersion(preview.versionId); // 读回当时展示的数组
```

- 条件和接受记录按 stamp 隔离；`a` 上的 `same/bound` 与 `b` 上的 `wrong` 不会互相污染。
- 已在当前 stamp 生效的目标再次 `accept` 会返回同一 `patchId`/`conditionIdentity`，标记 `alreadyEffective`。
- 其他 stamp 的同名条件实例不能直接移动；错误码为 `CROSS_STAMP_CONDITION`。
- 来源步次不明的旧条件可用 `importLegacyCondition` 捕获 `STEP_RESOLUTION_REQUIRED`，界面选择 `resolveLegacy(id,'rebuild',{stamp})` 或 `resolveLegacy(id,'history')`。
- `submitFrame(stamp, frame)` 接受 `imageId/pictureId`、`featureGrid/features`、`constrainedPixels/pixels` 和当前协方差模型；约束像素会进入该 stamp 的有效条件集。

### 错误语义

| 含义 | 错误类 | `code` |
| --- | --- | --- |
| 协方差矩阵/模型行不可用 | `MatrixUnavailableError` | `MATRIX_UNAVAILABLE` |
| 条件不相容 | `UnsatisfiableConstraintsError` | `CONSTRAINTS_UNSATISFIABLE` |
| 缺少画面、特征、像素、区域或条件定义 | `MissingInputError` | `MISSING_INPUT` |
| 旧条件步次/相关轴不明 | `StepResolutionRequiredError` | `STEP_RESOLUTION_REQUIRED` |
| 跨 stamp 移动条件 | `CrossStampConditionError` | `CROSS_STAMP_CONDITION` |

错误的 `codes` 字段还包含常见英文别名。若调用方希望按状态读取而不是捕获异常，可使用 `evaluateConditionalNoise(options)`，返回 `status: 'ok' | 'matrix-unavailable' | 'unsatisfiable' | 'missing-input' | ...`。

常用命令：

```sh
npm run inspect   # 只读取资料元数据
npm test          # 输入契约与条件噪声/编辑器测试
npm run demo      # 回放 noise-key.json 的 view
```

