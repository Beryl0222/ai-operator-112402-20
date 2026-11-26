import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import {
  sampleConditional,
  createEditor,
  NativeNoiseSource,
  nativeNormalValue,
  UnsatisfiableConstraintsError,
  MatrixUnavailableError,
  MissingInputError,
  StepResolutionRequiredError,
  CrossStampConditionError,
} from '../index.mjs';
import { noiseNormal, conditionTile } from '../inputs/noise-key.mjs';

const data = JSON.parse(readFileSync(new URL('../inputs/noise-key.json', import.meta.url), 'utf8'));

test('原生 SHA-256/Box–Muller 身份与 inputs 参考一致', () => {
  const source = new NativeNoiseSource();
  for (const i of [0, 1, 17, 256]) {
    assert.equal(source.normal('T18', 'epsilon', i), noiseNormal('T18', 'epsilon', i));
    assert.equal(nativeNormalValue({ seed: data.seed, step: 'T19', component: 'eta', index: i }), noiseNormal('T19', 'eta', i));
  }
  assert.equal(source.stats().latentFetch, 4);
  source.normal('T18', 'epsilon', 0);
  assert.equal(source.stats().latentFetch, 4);
  assert.equal(source.stats().readCalls, 5);
});

test('相符的比例重复条件只占一个秩，冲突重复报告全部相关 ID', () => {
  const compatible = sampleConditional({
    stamp: 'a',
    conditions: ['bound', 'same'],
    region: [0, 16],
  });
  assert.equal(compatible.rank, 1);
  assert.equal(compatible.duplicateGroups[0].conditions.length, 2);
  assert.ok(compatible.maxResidual < 3e-6);

  assert.throws(
    () => sampleConditional({ stamp: 'a', conditions: ['bound', 'same', 'wrong'], region: [0, 16] }),
    (error) => {
      assert.ok(error instanceof UnsatisfiableConstraintsError);
      assert.equal(error.code, 'CONSTRAINTS_UNSATISFIABLE');
      assert.deepEqual(error.conditions.sort(), ['bound', 'same', 'wrong']);
      assert.match(error.message, /wrong/);
      assert.match(error.message, /same|bound/);
      return true;
    },
  );
});

test('条件值在 3e-6 内容差满足，且同种子结果可重复', () => {
  const options = {
    stamp: 'a',
    conditions: ['bound', 'low'],
    region: [0, 256],
    seed: 'repeatable-seed',
  };
  const a = sampleConditional(options);
  const b = sampleConditional(options);
  assert.deepEqual(a.values, b.values);

  for (const id of ['bound', 'low']) {
    const c = data.conditions.find((x) => x[0] === id);
    let sum = 0;
    c[1].forEach((index, i) => {
      const pos = a.indices.indexOf(index);
      if (pos >= 0) sum += c[2][i] * a.values[pos];
      else {
        // 条件索引不在请求区时，用报告中的残差已完成全量校验。
      }
    });
    if (c[1].every((index) => a.indices.includes(index))) {
      assert.ok(Math.abs(sum - c[3]) < 3e-6);
    }
  }
  assert.ok(a.maxResidual < 3e-6);
});

test('改变条件顺序和块划分不改变已交付坐标值', () => {
  const conditions = ['bound', 'same', 'low'];
  const forward = sampleConditional({ stamp: 'a', conditions, region: [0, 256] });
  const reverse = sampleConditional({
    stamp: 'a',
    conditions: [...conditions].reverse(),
    region: [0, 256],
  });
  assert.deepEqual(reverse.values, forward.values);

  const left = sampleConditional({ stamp: 'a', conditions, region: [0, 128] });
  const right = sampleConditional({ stamp: 'a', conditions, region: [128, 256] });
  assert.deepEqual([...left.values, ...right.values], forward.values);
});

test('8 个 conditionTile 与小例条件在取数预算内可解且顺序无关', () => {
  const conditions = ['bound', 'same', 'low'];
  for (let tile = 0; tile < data.maxConditionTiles; tile += 1) {
    conditions.push(...conditionTile(tile));
  }
  const result = sampleConditional({ stamp: 'a', conditions, region: [128, 256] });
  assert.equal(result.conditions.length, 3 + data.maxConditionTiles * data.tileConditions);
  assert.ok(result.maxResidual < 3e-6);
  assert.ok(result.latentFetch < data.latentFetch);
  assert.equal(result.withinFetchBudget, true);
  assert.ok(result.budget.totalRetainedBytes <= data.workBytes);

  const reordered = sampleConditional({
    stamp: 'a',
    conditions: [...conditions].reverse(),
    region: [128, 256],
  });
  assert.deepEqual(reordered.values, result.values);
});

test('编辑器按 view 回放，历史保留第一次展示版本，b 步不被 a 的冲突污染', () => {
  const editor = createEditor();
  const run = editor.runView();
  assert.equal(run.ok, true, JSON.stringify(run.steps.find((s) => !s.ok)?.error));

  const first = run.steps.find((s) => s.op === 'sample').result;
  const history = editor.history('a', [0, 64]);
  assert.deepEqual(history.values, first.values);
  assert.equal(history.conditionIds.includes('low'), false);

  const later = editor.request('a', [0, 64]);
  assert.notDeepEqual(later.values, first.values);
  const readBack = editor.readVersion(first.versionId);
  assert.deepEqual(readBack.values, first.values);

  const bWrong = run.steps.find((s) => s.op === 'commit' && s.stamp === 'b');
  assert.equal(bWrong.ok, true);
  assert.equal(bWrong.result.condition.id, 'wrong');
});

test('接受已生效条件是幂等引用，不能跨 stamp 移动同名实例', () => {
  const editor = createEditor();
  editor.condition('a', 'bound');
  const first = editor.accept('a', 'bound');
  const second = editor.accept('a', 'bound');
  assert.equal(first.conditionAlreadyEffective, true);
  assert.equal(first.alreadyAccepted, false);
  assert.equal(second.alreadyAccepted, true);
  assert.equal(second.alreadyEffective, true);
  assert.equal(first.patchId, second.patchId);
  assert.equal(first.conditionId, 'bound');

  assert.throws(() => editor.accept('b', 'bound'), CrossStampConditionError);
  // 全局定义 wrong 可以在 b 创建属于 b 的新实例，但不是移动 a 的实例。
  const committed = editor.commit('b', 'wrong');
  assert.equal(committed.stamp, 'b');
  assert.equal(editor.sessions.get('b').conditions.get('wrong').stamp, 'b');
  assert.equal(editor.sessions.get('b').conditions.get('wrong').step, 'T18');
  assert.equal(editor.sessions.get('b').model.basis, 'basis2');
});

test('未知步次旧条件要求 rebuild 或 history，并可在当前 stamp 重建', () => {
  const editor = createEditor();
  const legacy = { id: 'old-patch', indices: [0, 1], weights: [0.5, 0.5], value: 0.11 };
  assert.throws(
    () => editor.importLegacyCondition(legacy, { throwOnUnknown: true }),
    StepResolutionRequiredError,
  );
  const attached = editor.importLegacyCondition(legacy);
  assert.equal(attached.status, 'step-resolution-required');
  assert.deepEqual(attached.choices, ['rebuild', 'history']);

  const historyChoice = editor.resolveLegacy('old-patch', 'history');
  assert.equal(historyChoice.choice, 'history');
  const rebuilt = editor.resolveLegacy('old-patch', 'rebuild', { stamp: 'c' });
  assert.equal(rebuilt.ok, true);
  assert.match(rebuilt.condition.id, /rebuilt-c/);
  assert.equal(editor.sessions.get('c').model.step, 'T19');
});

test('提交帧会应用约束，展示值可接受为后续条件并保持可复现', () => {
  const editor = createEditor();
  const submitted = editor.submitFrame('a', {
    imageId: 'IMG-1',
    featureGrid: { mask: [1, 1, 0] },
    constrainedPixels: [{ index: 17, value: 0.42 }],
  });
  assert.deepEqual(submitted.conditionIds, ['pixel-17']);

  const preview = editor.sample('a', [16, 20], { seed: 'example' });
  const acceptance = editor.acceptVersion('a', preview.versionId, { indices: [16, 18] });
  assert.equal(acceptance.conditionIds.length, 2);
  const continued = editor.request('a', [16, 20]);
  assert.ok(continued.maxResidual < 3e-6);
  assert.equal(continued.seed, 'example');
  assert.deepEqual(editor.readVersion(preview.versionId).values, preview.values);
});

test('矩阵不可用、约束不可满足和缺少输入是不同错误', () => {
  assert.throws(
    () => sampleConditional({ covarianceModel: { available: false }, region: [0, 1] }),
    MatrixUnavailableError,
  );
  assert.throws(
    () => sampleConditional({ stamp: 'a', conditions: ['wrong'] }, undefined),
    MissingInputError,
  );
  assert.throws(
    () => sampleConditional({ stamp: 'a', conditions: ['same', 'wrong'], region: [0, 8] }),
    UnsatisfiableConstraintsError,
  );
  const editor = createEditor();
  assert.throws(() => editor.submitFrame({ imageId: 'img' }), MissingInputError);
});
