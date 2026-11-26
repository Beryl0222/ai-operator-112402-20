import { MissingInputError, UnsatisfiableConstraintsError } from './errors.mjs';
import { canonicalIdentity, loadNoiseKeyData, sha256Hex } from './native-noise.mjs';

function conditionTuple(input) {
  if (Array.isArray(input)) {
    const [id, indices, weights, value] = input;
    return { id, indices, weights, value };
  }
  return input;
}

function asFloatArray(value, field) {
  if (value == null) return null;
  if (ArrayBuffer.isView(value)) return Array.from(value, Number);
  if (Array.isArray(value)) return value.map(Number);
  throw new MissingInputError(`${field} 必须是数组`, { field, value });
}

/**
 * 把 tuple / 对象 / 单像素约束统一为 {id, entries:[{index,weight}], value}。
 * 同一约束内重复 index 会合并。
 */
export function normalizeCondition(input, options = {}) {
  if (input == null) throw new MissingInputError('条件不能为空', { field: 'condition' });

  let raw = conditionTuple(input);
  if (typeof raw === 'string') {
    const definition = options.definitions?.get?.(raw) ?? options.definitions?.[raw];
    if (!definition) {
      throw new MissingInputError(`找不到条件定义: ${raw}`, { conditionId: raw, field: 'condition' });
    }
    raw = conditionTuple(definition);
  }

  let id = raw.id ?? raw.conditionId ?? raw.name ?? raw.key ?? null;
  let indices = raw.indices ?? raw.index ?? raw.pixels ?? raw.pixelIndices ?? raw.coordinate;
  let weights =
    raw.weights ?? raw.coefficients ?? raw.coeffs ?? raw.w ?? raw.weight ?? raw.kernel;
  let value = raw.value ?? raw.b ?? raw.target ?? raw.rhs ?? raw.constrainedValue;

  // { pixel/index, value } 或 [{index,weight}]
  if (indices == null && (raw.pixel != null || raw.coordinate != null || raw.i != null)) {
    indices = raw.pixel ?? raw.coordinate ?? raw.i;
  }
  if (value == null && raw.pixelValue != null) value = raw.pixelValue;

  if (indices == null && Array.isArray(raw.entries)) {
    const merged = new Map();
    for (const entry of raw.entries) {
      const idx = Number(entry.index ?? entry[0]);
      const w = Number(entry.weight ?? entry.w ?? entry[1] ?? 1);
      merged.set(idx, (merged.get(idx) ?? 0) + w);
    }
    indices = [...merged.keys()];
    weights = [...merged.values()];
  }

  if (typeof indices === 'number' || Number.isInteger(indices)) indices = [indices];
  if (weights == null && Array.isArray(indices)) weights = indices.map(() => 1);
  if (typeof weights === 'number') weights = [weights];

  if (!Array.isArray(indices) || indices.length === 0) {
    throw new MissingInputError('条件缺少 indices/像素坐标', { conditionId: id, field: 'indices' });
  }
  indices = Array.from(indices, Number);
  if (!indices.every(Number.isInteger)) {
    throw new MissingInputError('条件索引必须是整数', { conditionId: id, indices });
  }

  weights = asFloatArray(weights, 'weights');
  if (weights.length !== indices.length) {
    throw new MissingInputError('indices 与 weights 长度不一致', {
      conditionId: id,
      indicesLength: indices.length,
      weightsLength: weights.length,
    });
  }
  if (value == null || !Number.isFinite(Number(value))) {
    throw new MissingInputError('条件缺少有限的约束值 value/b', { conditionId: id, field: 'value' });
  }
  value = Number(value);

  const merged = new Map();
  for (let i = 0; i < indices.length; i += 1) {
    const index = indices[i];
    const weight = Number(weights[i]);
    if (!Number.isFinite(weight)) {
      throw new MissingInputError('条件权重必须是有限数值', { conditionId: id, index });
    }
    merged.set(index, (merged.get(index) ?? 0) + weight);
  }
  const entries = [...merged.entries()]
    .map(([index, weight]) => ({ index, weight }))
    .filter((entry) => entry.weight !== 0)
    .sort((a, b) => a.index - b.index);

  if (entries.length === 0) {
    // 0*z = b：若 b 也为 0，则是恒真条件；否则不可满足。
    if (Math.abs(value) > (options.covarianceTol ?? 1e-8)) {
      throw new UnsatisfiableConstraintsError(`零系数条件要求非零值: ${id ?? '(未命名)'}`, {
        conflicts: [{ kind: 'zero-row', conditions: id ? [id] : [], value }],
        conditions: id ? [id] : [],
      });
    }
  }

  const canonical = canonicalRow(entries, value);
  const contentHash = sha256Hex({
    v: 1,
    entries: entries.map((e) => [e.index, roundKey(e.weight)]),
    value: roundKey(value),
  }).slice(0, 16);
  id ??= `C-${contentHash}`;

  return {
    id: String(id),
    conditionId: String(id),
    constraintId: String(id),
    key: raw.key ?? `${String(id)}@${contentHash}`,
    name: raw.name ? String(raw.name) : String(id),
    hash: contentHash,
    contentHash,
    identity: raw.identity ?? `${String(id)}@${contentHash}`,
    entries,
    indices: entries.map((e) => e.index),
    weights: entries.map((e) => e.weight),
    value,
    b: value,
    stamp: raw.stamp ?? options.stamp ?? null,
    step: raw.step ?? options.step ?? null,
    basis: raw.basis ?? options.basis ?? null,
    acquiredAt: raw.acquiredAt ?? null,
    source: raw.source ?? null,
    patchId: raw.patchId ?? raw.tile ?? raw.patch ?? null,
    raw,
    canonical,
  };
}

function roundKey(x) {
  // 身份哈希保留足够精度，同时避免 -0。
  return Object.is(x, -0) ? 0 : Number(x.toFixed(12));
}

/** 返回与比例无关的规范行及把 b 变换到该行时使用的 scale。 */
export function canonicalRow(entries, value) {
  if (entries.length === 0) {
    return { support: '', weights: [], value: 0, scale: 1, signature: 'zero' };
  }
  const maxAbs = Math.max(...entries.map((e) => Math.abs(e.weight)));
  const firstSign = entries[0].weight >= 0 ? 1 : -1;
  const scale = firstSign * maxAbs;
  const weights = entries.map((e) => e.weight / scale);
  const canonicalValue = value / scale;
  const support = entries.map((e) => e.index).join(',');
  const signature =
    support + '|' + weights.map((w) => roundKey(w).toFixed(12)).join(',');
  return { support, weights, value: canonicalValue, scale, signature };
}

function rowsProportional(a, b, tolerance) {
  if (a.entries.length !== b.entries.length) return false;
  if (a.canonical.support !== b.canonical.support) return false;
  for (let i = 0; i < a.canonical.weights.length; i += 1) {
    if (Math.abs(a.canonical.weights[i] - b.canonical.weights[i]) > tolerance) return false;
  }
  return true;
}

/**
 * 检查同一超平面的重复条件。相容重复合并为一个数学秩；
 * 冲突重复抛出包含全部相关 ID 的错误。
 */
export function resolveConditionDuplicates(conditions, options = {}) {
  const tol = options.covarianceTol ?? 1e-8;
  const valueTol = options.consistencyTolerance ?? tol;
  const clusters = [];

  for (const condition of conditions) {
    if (condition.canonical.signature === 'zero') {
      let cluster = clusters.find((c) => c.kind === 'zero');
      if (!cluster) {
        cluster = { kind: 'zero', signature: 'zero', members: [] };
        clusters.push(cluster);
      }
      cluster.members.push(condition);
      continue;
    }

    // 先按 support 分桶，避免 8 个 tile 时做 O(m^2) 的权重比较。
    let cluster = clusters.find(
      (c) => c.kind === 'row' && c.support === condition.canonical.support &&
        rowsProportional(c.representative, condition, tol),
    );
    if (!cluster) {
      cluster = {
        kind: 'row',
        support: condition.canonical.support,
        signature: condition.canonical.signature,
        representative: condition,
        members: [],
      };
      clusters.push(cluster);
    }
    cluster.members.push(condition);
  }

  const equations = [];
  const duplicateGroups = [];
  const conflicts = [];

  for (const cluster of clusters) {
    if (cluster.kind === 'zero') {
      const bad = cluster.members.filter((c) => Math.abs(c.value) > valueTol);
      if (bad.length > 0) {
        conflicts.push({
          kind: 'zero-row',
          conditions: cluster.members.map((c) => c.id),
          incompatible: bad.map((c) => c.id),
        });
      }
      duplicateGroups.push({
        signature: 'zero',
        conditions: cluster.members.map((c) => c.id),
        rankAdded: 0,
      });
      continue;
    }

    const values = cluster.members.map((c) => c.canonical.value);
    const ref = values[0];
    const divergent = cluster.members.filter(
      (c) => Math.abs(c.canonical.value - ref) > valueTol * Math.max(1, Math.abs(ref)),
    );

    if (divergent.length > 0) {
      const groupIds = cluster.members.map((c) => c.id);
      const incompatible = divergent.map((c) => c.id);
      const conflict = {
        kind: 'duplicate-linear-combination',
        signature: cluster.signature,
        conditions: groupIds,
        compatible: cluster.members.filter((c) => !divergent.includes(c)).map((c) => c.id),
        incompatible,
        normalizedValues: cluster.members.map((c) => ({
          condition: c.id,
          value: c.canonical.value,
          contentHash: c.contentHash,
        })),
        message:
          `同一线性组合的条件取值冲突，无法共存: ${incompatible.join(', ')}` +
          ` 与 ${groupIds.filter((id) => !incompatible.includes(id)).join(', ') || '其他条件'}`,
      };
      conflicts.push(conflict);
    }

    duplicateGroups.push({
      signature: cluster.signature,
      conditions: cluster.members.map((c) => c.id),
      consistent: divergent.length === 0,
      rankAdded: 1,
    });

    // 即使有冲突也构造报告；调用方会统一抛错。相容时用字典序最小 ID，
    // 使输入顺序不影响数值路径。
    const sortedMembers = [...cluster.members].sort((a, b) => a.id.localeCompare(b.id));
    const representative = sortedMembers[0];
    equations.push({
      id: representative.id,
      representative,
      conditionIds: cluster.members.map((c) => c.id).sort(),
      entries: representative.entries,
      value: representative.value,
      canonical: representative.canonical,
      contentHashes: cluster.members.map((c) => c.contentHash).sort(),
      duplicateCount: cluster.members.length,
    });
  }

  if (conflicts.length > 0) {
    const ids = [...new Set(conflicts.flatMap((c) => c.conditions))];
    const error = new UnsatisfiableConstraintsError(
      conflicts.map((c) => c.message).filter(Boolean).join('；') || '重复条件彼此冲突',
      {
        conflicts,
        conditions: ids,
        conflictingConditions: conflicts.flatMap((c) => {
          const bad = c.incompatible ?? [];
          const good = (c.conditions ?? []).filter((id) => !bad.includes(id));
          return bad.flatMap((id) => good.map((other) => [id, other]));
        }),
        duplicateGroups,
      },
    );
    throw error;
  }

  // 规范排序：先坐标/support，再权重，最后代表 ID。请求注册顺序因此不影响求解。
  equations.sort((a, b) => {
    const sa = a.entries.map((e) => `${e.index}:${e.weight.toFixed(12)}`).join('|');
    const sb = b.entries.map((e) => `${e.index}:${e.weight.toFixed(12)}`).join('|');
    if (sa < sb) return -1;
    if (sa > sb) return 1;
    return a.id.localeCompare(b.id);
  });

  return { equations, duplicateGroups, conflicts };
}

export function loadConditionDefinitions(data = loadNoiseKeyData()) {
  const map = new Map();
  for (const condition of data.conditions ?? []) map.set(condition[0], condition);
  for (const tile = 0; tile < (data.maxConditionTiles ?? 0); tile += 1) {
    // 延迟由 conditionTile 调用方处理；这里只放静态 definitions。
  }
  return map;
}
