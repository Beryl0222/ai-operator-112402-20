import { noiseRow as inputNoiseRow } from '../inputs/noise-key.mjs';
import { MissingInputError, MatrixUnavailableError } from './errors.mjs';
import { loadNoiseKeyData, sha256Hex } from './native-noise.mjs';

export function gridCellCount(grid) {
  if (!Array.isArray(grid) || grid.length === 0) {
    throw new MissingInputError('缺少有效的 grid/featureGrid 尺寸', { field: 'grid' });
  }
  let n = 1;
  for (const dim of grid) {
    if (!Number.isInteger(dim) || dim <= 0) {
      throw new MissingInputError('grid 维度必须是正整数', { field: 'grid', grid });
    }
    n *= dim;
  }
  return n;
}

export function normalizeIndices(indices, size, field = 'indices') {
  if (!Array.isArray(indices) && !(indices instanceof Set) && !ArrayBuffer.isView(indices)) {
    throw new MissingInputError(`缺少 ${field}`, { field });
  }
  const out = [];
  const seen = new Set();
  for (const value of indices) {
    const i = Number(value);
    if (!Number.isInteger(i) || i < 0 || i >= size) {
      throw new RangeError(`${field} 包含越界坐标: ${String(value)}`);
    }
    if (!seen.has(i)) {
      seen.add(i);
      out.push(i);
    }
  }
  return out;
}

/**
 * 支持半开区间 [start,end]、{start,end}、{offset,length}、
 * 显式 indices，以及扁平 index 数组。
 */
export function normalizeRegion(region, size, field = 'region') {
  if (region == null) throw new MissingInputError(`缺少 ${field}`, { field });

  if (typeof region === 'number') {
    if (!Number.isInteger(region) || region < 0 || region >= size) {
      throw new RangeError(`${field} 坐标越界: ${region}`);
    }
    return [region];
  }

  if (Array.isArray(region) && region.length === 2 &&
      Number.isInteger(region[0]) && Number.isInteger(region[1]) &&
      region[0] <= region[1]) {
    const [start, end] = region;
    if (start < 0 || end > size) throw new RangeError(`${field} 区间越界: [${start},${end})`);
    return Array.from({ length: end - start }, (_, i) => start + i);
  }

  if (Array.isArray(region)) return normalizeIndices(region, size, field);

  if (ArrayBuffer.isView(region)) return normalizeIndices(Array.from(region), size, field);

  if (typeof region === 'object') {
    if (Array.isArray(region.indices)) return normalizeIndices(region.indices, size, field);
    if (region.range) return normalizeRegion(region.range, size, field);
    let start = region.start ?? region.offset ?? region.from ?? 0;
    let end = region.end ?? region.to;
    if (end == null && region.length != null) end = start + region.length;
    if (end == null && region.size != null) end = start + region.size;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start > end) {
      throw new MissingInputError(`${field} 需要合法的 start/end 或 offset/length`, { field, region });
    }
    return normalizeRegion([start, end], size, field);
  }

  throw new MissingInputError(`无法识别的 ${field}`, { field, region });
}

export function findStamp(data, stampId) {
  const stamp = data.stamps?.find((item) => item[0] === stampId || item.stamp === stampId);
  if (!stamp) {
    throw new MatrixUnavailableError(`未知模型印戳: ${String(stampId)}`, {
      stamp: stampId,
      reason: 'unknown-stamp',
      availableStamps: data.stamps?.map((s) => s[0]) ?? [],
    });
  }
  if (Array.isArray(stamp)) return { stamp: stamp[0], step: stamp[1], basis: stamp[2] };
  return { stamp: stamp.stamp, step: stamp.step, basis: stamp.basis };
}

/**
 * 稀疏行协方差模型。只按 index 读取 noiseRow(index,basis)，
 * 绝不构造 N*N 的 K。rowProvider 可替换为设备/远端适配器；
 * 若其报告矩阵不可用，调用方会收到 MatrixUnavailableError。
 */
export class CovarianceModel {
  constructor(options = {}) {
    this.data = options.data ?? loadNoiseKeyData(options.dataUrl);
    this.grid = options.grid ?? this.data.grid;
    this.size = gridCellCount(this.grid);
    this.rank = options.rank ?? this.data.rank;
    this.covarianceTol = options.covarianceTol ?? this.data.covarianceTol ?? 1e-8;
    this.conditionTolerance = options.conditionTolerance ?? 3e-6;
    this.stamp = options.stamp ?? null;
    this.step = options.step ?? null;
    this.basis = options.basis ?? null;
    this.modelId = options.modelId ?? options.id ?? null;
    this.resolutionId = options.resolutionId ?? sha256Hex(this.grid).slice(0, 12);
    const unavailableStatus =
      options.status === 'unavailable' ||
      options.availability === 'unavailable' ||
      options.matrixAvailable === false ||
      options.matrixUnavailable === true ||
      options.unavailable === true;
    this.available = options.available !== false && !unavailableStatus;
    this.unavailableReason =
      options.unavailableReason ?? (unavailableStatus ? options.reason ?? 'matrix-unavailable' : null);
    this._rowCache = new Map();
    this.rowReads = 0;
    this.rowProvider = options.rowProvider ?? options.row ?? ((index, basis) => inputNoiseRow(index, basis));

    if (this.stamp && !this.step) {
      const found = findStamp(this.data, this.stamp);
      this.stamp = found.stamp;
      this.step = found.step;
      this.basis ??= found.basis;
    }
    this.modelId ??= [this.stamp ?? 'unstamped', this.step ?? 'no-step', this.basis ?? 'no-basis'].join(':');
    this.axisKey = sha256Hex({
      step: this.step,
      basis: this.basis,
      grid: this.grid,
      rank: this.rank,
      resolutionId: this.resolutionId,
    }).slice(0, 16);
  }

  identity() {
    return {
      modelId: this.modelId,
      axisKey: this.axisKey,
      stamp: this.stamp,
      step: this.step,
      basis: this.basis,
      grid: [...this.grid],
      size: this.size,
      rank: this.rank,
      resolutionId: this.resolutionId,
      covarianceTol: this.covarianceTol,
      conditionTolerance: this.conditionTolerance,
    };
  }

  unavailable(reason = 'matrix-unavailable') {
    this.available = false;
    this.unavailableReason = reason;
    this._rowCache.clear();
    return this;
  }

  row(index) {
    if (!this.available) {
      throw new MatrixUnavailableError('当前步的协方差模型/矩阵不可用', {
        model: this.identity(),
        reason: this.unavailableReason ?? 'model-marked-unavailable',
      });
    }
    if (!Number.isInteger(index) || index < 0 || index >= this.size) {
      throw new RangeError(`noise row 坐标越界: ${index}`);
    }
    if (this._rowCache.has(index)) return this._rowCache.get(index);

    let row;
    try {
      row = this.rowProvider(index, this.basis, this);
    } catch (error) {
      if (error instanceof MatrixUnavailableError) throw error;
      throw new MatrixUnavailableError(`协方差行读取失败: index=${index}`, {
        model: this.identity(),
        index,
        causeName: error?.name,
        causeMessage: error?.message,
      });
    }
    if (!row || !ArrayBuffer.isView(row.u) && !Array.isArray(row.u)) {
      throw new MatrixUnavailableError('协方差行缺少 d/u 特征', {
        model: this.identity(),
        index,
      });
    }
    if (row.u.length !== this.rank) {
      throw new MatrixUnavailableError('协方差行 rank 与模型不一致', {
        model: this.identity(),
        index,
        expectedRank: this.rank,
        actualRank: row.u.length,
      });
    }
    const normalized = { d: Number(row.d ?? row.diagonal ?? 0), u: row.u };
    this._rowCache.set(index, normalized);
    this.rowReads += 1;
    return normalized;
  }

  /** K_ij = d_i^2 [i=j] + u_i·u_j；稀疏校验时才按需计算。 */
  covarianceEntry(i, j) {
    const ri = this.row(i);
    const rj = this.row(j);
    let value = i === j ? ri.d * rj.d : 0;
    for (let k = 0; k < this.rank; k += 1) value += ri.u[k] * rj.u[k];
    return value;
  }

  stats() {
    const retainedScalars = this._rowCache.size * (this.rank + 1);
    const rowRetainedBytes = this._rowCache.size * this.rank * 8;
    return {
      rowReads: this.rowReads,
      cachedRows: this._rowCache.size,
      retainedRows: this._rowCache.size,
      retainedScalars,
      rowRetainedBytes,
      modelRetainedBytes: rowRetainedBytes,
    };
  }
}

export function createCovarianceModel(options = {}) {
  if (options instanceof CovarianceModel) return options;
  if (options.model instanceof CovarianceModel) return options.model.for?.(options.stamp) ?? options.model;
  return new CovarianceModel(options);
}

export function createStampModel(stampId, options = {}) {
  const data = options.data ?? loadNoiseKeyData(options.dataUrl);
  const known = data.stamps?.find((item) => item[0] === stampId || item.stamp === stampId);
  if (known) {
    const stamp = Array.isArray(known)
      ? { stamp: known[0], step: known[1], basis: known[2] }
      : { stamp: known.stamp, step: known.step, basis: known.basis };
    return new CovarianceModel({ ...options, data, ...stamp });
  }
  if (options.step || options.grid || options.rowProvider || options.covarianceMatrix) {
    return new CovarianceModel({
      stamp: null,
      ...options,
      data,
      step: options.step ?? (typeof stampId === 'string' ? stampId : null),
    });
  }
  const stamp = findStamp(data, stampId);
  return new CovarianceModel({ ...options, data, ...stamp });
}
