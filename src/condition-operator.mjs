import {
  MatrixUnavailableError,
  MissingInputError,
  UnsatisfiableConstraintsError,
} from './errors.mjs';
import {
  normalizeCondition,
  resolveConditionDuplicates,
} from './conditions.mjs';
import {
  CovarianceModel,
  normalizeRegion,
} from './model.mjs';
import {
  NativeNoiseSource,
  loadNoiseKeyData,
  sha256Hex,
} from './native-noise.mjs';
import { choleskyFactor, solveCholesky, pseudoinverseSolve, dot } from './linalg.mjs';
import { adaptDenseCovariance } from './dense-model.mjs';
import { conditionTile as inputConditionTile } from '../inputs/noise-key.mjs';

export function createDefaultDefinitions(data = loadNoiseKeyData()) {
  const definitions = new Map();
  for (const condition of data.conditions ?? []) definitions.set(condition[0], condition);
  for (let tile = 0; tile < (data.maxConditionTiles ?? 0); tile += 1) {
    for (const condition of inputConditionTile(tile)) definitions.set(condition[0], condition);
  }
  return definitions;
}

function normalizeManyConditions(conditions, options) {
  const list = conditions == null ? [] : Array.isArray(conditions) ? conditions : [conditions];
  const definitions = options.definitions ?? createDefaultDefinitions(options.data);
  return list.map((item) => normalizeCondition(item, { ...options, definitions }));
}

export function resolveModel(options, data) {
  if (options.model instanceof CovarianceModel) return options.model;
  if (options.covarianceModel instanceof CovarianceModel) return options.covarianceModel;
  if (typeof options.model === 'string' && options.stamp == null) {
    options = { ...options, stamp: options.model };
  }
  if (typeof options.covarianceModel === 'string' && options.stamp == null) {
    options = { ...options, stamp: options.covarianceModel };
  }

  let plainSpec =
    options.covarianceModel && typeof options.covarianceModel === 'object'
      ? options.covarianceModel
      : options.model && typeof options.model === 'object' && !Array.isArray(options.model)
        ? options.model
        : {};
  plainSpec = adaptDenseCovariance(plainSpec);

  const adapted = {};
  if (typeof plainSpec.getRow === 'function') {
    adapted.rowProvider = (index, basis) => plainSpec.getRow(index, basis);
  } else if (typeof plainSpec.covarianceRow === 'function') {
    adapted.rowProvider = (index, basis) => plainSpec.covarianceRow(index, basis);
  } else if (typeof plainSpec.rowAt === 'function') {
    adapted.rowProvider = (index, basis) => plainSpec.rowAt(index, basis);
  } else if (typeof plainSpec.getNoiseRow === 'function') {
    adapted.rowProvider = (index, basis) => plainSpec.getNoiseRow(index, basis);
  } else if (typeof plainSpec.noiseRow === 'function') {
    adapted.rowProvider = (index, basis) => plainSpec.noiseRow(index, basis);
  } else if (typeof plainSpec.row === 'function') {
    adapted.rowProvider = plainSpec.row;
  }

  return new CovarianceModel({ data, ...options, ...plainSpec, ...adapted });
}

function buildSystem({ model, native, equations }) {
  const m = equations.length;
  const rank = model.rank;
  const eta = Array.from({ length: rank }, (_, k) => native.normal(model.step, 'eta', k));

  const rows = equations.map((equation) => {
    const gE = new Map();
    const gL = new Float64Array(rank);
    let gx = 0;

    for (const entry of equation.entries) {
      const covarianceRow = model.row(entry.index);
      if (covarianceRow.d !== 0) {
        const coeff = entry.weight * covarianceRow.d;
        gE.set(entry.index, (gE.get(entry.index) ?? 0) + coeff);
        gx += coeff * native.normal(model.step, 'epsilon', entry.index);
      }
      for (let k = 0; k < rank; k += 1) {
        const coeff = entry.weight * covarianceRow.u[k];
        gL[k] += coeff;
        gx += coeff * eta[k];
      }
    }

    return { equation, gE, gL, gx, rhs: equation.value - gx };
  });

  const epsilonTerms = new Map();
  rows.forEach((row, q) => {
    for (const [index, coeff] of row.gE) {
      if (!epsilonTerms.has(index)) epsilonTerms.set(index, []);
      epsilonTerms.get(index).push({ q, coeff });
    }
  });

  return { m, rank, eta, rows, epsilonTerms };
}

class DSU {
  constructor(n) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(x) {
    while (this.parent[x] !== x) {
      this.parent[x] = this.parent[this.parent[x]];
      x = this.parent[x];
    }
    return x;
  }
  union(a, b) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[rb] = ra;
  }
}

function solveRowsOrthogonally(system, model) {
  const { m, rank, rows, epsilonTerms } = system;
  const epsilonIndices = [...epsilonTerms.keys()];
  const epsilonPosition = new Map(epsilonIndices.map((index, position) => [index, position]));
  const p = epsilonIndices.length + rank;

  const G = rows.map((row) => {
    const g = new Float64Array(p);
    for (const [index, coefficient] of row.gE) {
      g[epsilonPosition.get(index)] = coefficient;
    }
    for (let k = 0; k < rank; k += 1) g[epsilonIndices.length + k] = row.gL[k];
    return g;
  });

  const Q = [];
  const delta = new Float64Array(p);
  const dependencies = [];
  let mathRank = 0;

  for (let i = 0; i < m; i += 1) {
    const g = G[i];
    const q = Float64Array.from(g);
    const projections = [];
    for (const unit of Q) {
      const beta = dot(g, unit);
      projections.push(beta);
      for (let j = 0; j < p; j += 1) q[j] -= beta * unit[j];
    }

    const qNorm2 = dot(q, q);
    const gNorm2 = dot(g, g);
    const cutoff = model.covarianceTol * Math.max(1, gNorm2);
    const residual = rows[i].rhs - dot(g, delta);

    if (qNorm2 > cutoff) {
      const norm = Math.sqrt(qNorm2);
      const unit = new Float64Array(p);
      for (let j = 0; j < p; j += 1) unit[j] = q[j] / norm;
      // g·unit === norm；把当前行的残差正交消去。
      const alpha = residual / norm;
      for (let j = 0; j < p; j += 1) delta[j] += alpha * unit[j];
      Q.push(unit);
      mathRank += 1;
    } else {
      dependencies.push({
        kind: 'linear-dependency',
        equation: rows[i].equation.id,
        equationId: rows[i].equation.id,
        conditions: rows[i].equation.conditionIds,
        qNorm2,
        cutoff,
        residual,
        projections,
      });
    }
  }

  const deltaEpsilon = new Map();
  epsilonIndices.forEach((index, position) => {
    if (Math.abs(delta[position]) > 0) deltaEpsilon.set(index, delta[position]);
  });
  const deltaEta = Float64Array.from(delta.subarray(epsilonIndices.length));

  return {
    y: [],
    solver: 'orthogonal-row-qr',
    mathRank,
    nullVectors: [],
    dependencies,
    deltaEpsilon,
    deltaEta,
  };
}

function solveWoodburyOrPseudo(system, model) {
  const { m, rank, rows, epsilonTerms } = system;
  const rhs = rows.map((row) => row.rhs);
  if (m === 0) {
    return { y: [], solver: 'empty', mathRank: 0, nullVectors: [], sparseSingular: false };
  }

  const dsu = new DSU(m);
  for (const terms of epsilonTerms.values()) {
    for (let i = 1; i < terms.length; i += 1) dsu.union(terms[0].q, terms[i].q);
  }
  const componentMap = new Map();
  for (let q = 0; q < m; q += 1) {
    const root = dsu.find(q);
    if (!componentMap.has(root)) componentMap.set(root, []);
    componentMap.get(root).push(q);
  }

  const sinvL = Array.from({ length: m }, () => new Float64Array(rank));
  const sinvRhs = new Float64Array(m);
  let sparseSingular = false;

  for (const qs of componentMap.values()) {
    const len = qs.length;
    const block = Array.from({ length: len }, () => new Float64Array(len));
    for (let a = 0; a < len; a += 1) {
      for (let b = a; b < len; b += 1) {
        let sum = 0;
        for (const [index, ca] of rows[qs[a]].gE) {
          const cb = rows[qs[b]].gE.get(index);
          if (cb !== undefined) sum += ca * cb;
        }
        block[a][b] = sum;
        if (a !== b) block[b][a] = sum;
      }
    }

    const B = Array.from({ length: len }, (_, local) => {
      const q = qs[local];
      const out = new Float64Array(rank + 1);
      for (let k = 0; k < rank; k += 1) out[k] = rows[q].gL[k];
      out[rank] = rhs[q];
      return out;
    });

    const factor = choleskyFactor(block, { tolerance: model.covarianceTol });
    if (factor.singular) {
      sparseSingular = true;
      break;
    }
    const X = solveCholesky(factor.L, B);
    for (let local = 0; local < len; local += 1) {
      const q = qs[local];
      for (let k = 0; k < rank; k += 1) sinvL[q][k] = X[local][k];
      sinvRhs[q] = X[local][rank];
    }
  }

  if (!sparseSingular) {
    const J = Array.from({ length: rank }, (_, k) =>
      Float64Array.from({ length: rank }, (_, l) => {
        let value = k === l ? 1 : 0;
        for (let q = 0; q < m; q += 1) value += rows[q].gL[k] * sinvL[q][l];
        return value;
      }),
    );
    const jFactor = choleskyFactor(J, { tolerance: model.covarianceTol });
    if (!jFactor.singular) {
      const t = new Float64Array(rank);
      for (let k = 0; k < rank; k += 1) {
        for (let q = 0; q < m; q += 1) t[k] += rows[q].gL[k] * sinvRhs[q];
      }
      const hMatrix = solveCholesky(jFactor.L, Array.from(t, (value) => [value]));
      const h = hMatrix.map((row) => row[0]);
      const y = new Float64Array(m);
      for (let q = 0; q < m; q += 1) {
        y[q] = sinvRhs[q];
        for (let k = 0; k < rank; k += 1) y[q] -= sinvL[q][k] * h[k];
      }
      return {
        y: Array.from(y),
        solver: 'woodbury-sparse-low-rank',
        mathRank: m,
        nullVectors: [],
        sparseSingular,
      };
    }
  }

  const M = Array.from({ length: m }, () => new Float64Array(m));
  for (let q = 0; q < m; q += 1) {
    for (let p = q; p < m; p += 1) {
      let sum = 0;
      for (const [index, cq] of rows[q].gE) {
        const cp = rows[p].gE.get(index);
        if (cp !== undefined) sum += cq * cp;
      }
      for (let k = 0; k < rank; k += 1) sum += rows[q].gL[k] * rows[p].gL[k];
      M[q][p] = sum;
      M[p][q] = sum;
    }
  }

  const denseFactor = choleskyFactor(M, { tolerance: model.covarianceTol });
  if (!denseFactor.singular) {
    const solved = solveCholesky(
      denseFactor.L,
      rhs.map((value) => [value]),
    );
    return {
      y: solved.map((row) => row[0]),
      solver: 'dense-cholesky',
      mathRank: m,
      nullVectors: [],
      sparseSingular,
    };
  }

  return solveRowsOrthogonally(system, model);
}

function createValueReader({ model, native, system, solution }) {
  const { eta, rows } = system;
  const y = solution.y;
  const deltaEta = solution.deltaEta
    ? Float64Array.from(solution.deltaEta)
    : new Float64Array(model.rank);
  if (!solution.deltaEta) {
    for (let q = 0; q < rows.length; q += 1) {
      for (let k = 0; k < model.rank; k += 1) deltaEta[k] += rows[q].gL[k] * y[q];
    }
  }

  const deltaEpsilon = solution.deltaEpsilon ? new Map(solution.deltaEpsilon) : new Map();
  if (!solution.deltaEpsilon) {
    for (const [index, terms] of system.epsilonTerms) {
      let delta = 0;
      for (const { q, coeff } of terms) delta += coeff * y[q];
      deltaEpsilon.set(index, delta);
    }
  }

  const cache = new Map();
  const reader = (index) => {
    if (cache.has(index)) return cache.get(index);
    const row = model.row(index);
    const eps = row.d === 0 ? 0 : native.normal(model.step, 'epsilon', index);
    let unconditioned = row.d * eps;
    let etaCorrection = 0;
    for (let k = 0; k < model.rank; k += 1) {
      unconditioned += row.u[k] * eta[k];
      etaCorrection += row.u[k] * deltaEta[k];
    }
    const epsCorrection = row.d * (deltaEpsilon.get(index) ?? 0);
    const correction = epsCorrection + etaCorrection;
    const value = unconditioned + correction;
    const out = {
      index,
      value,
      unconditioned,
      correction,
      eps,
      deltaEpsilon: deltaEpsilon.get(index) ?? 0,
      deltaEta: Array.from(deltaEta),
    };
    cache.set(index, out);
    return out;
  };
  reader.deltaEta = deltaEta;
  reader.deltaEpsilon = deltaEpsilon;
  reader.cache = cache;
  return reader;
}

function buildUnsatisfiableError({ solution, resolved, rawConditions, reader, model }) {
  const residuals = rawConditions.map((condition) => {
    let sum = 0;
    for (const entry of condition.entries) sum += entry.weight * reader(entry.index).value;
    return { condition: condition.id, residual: sum - condition.value };
  });
  const bad = residuals.filter((r) => Math.abs(r.residual) > model.conditionTolerance);
  const conflicts = [];

  for (const dependency of solution.dependencies ?? []) {
    if (Math.abs(dependency.residual) <= model.conditionTolerance) continue;
    conflicts.push({
      kind: 'incompatible-linear-dependency',
      conditions: dependency.conditions ?? [dependency.equationId],
      equationIds: [dependency.equationId],
      equation: dependency.equationId,
      residual: dependency.residual,
      qNorm2: dependency.qNorm2,
    });
  }

  for (const nullVector of solution.nullVectors ?? []) {
    if (
      Math.abs(nullVector.rhsProjection) <=
      model.covarianceTol * Math.max(1, resolved.equations.length)
    ) {
      continue;
    }
    const coefficients = nullVector.vector
      .map((coefficient, q) => ({
        equation: resolved.equations[q].id,
        conditions: resolved.equations[q].conditionIds,
        coefficient,
        abs: Math.abs(coefficient),
      }))
      .filter((x) => x.abs > model.covarianceTol)
      .sort((a, b) => b.abs - a.abs);
    conflicts.push({
      kind: 'linear-dependency',
      conditions: [...new Set(coefficients.flatMap((x) => x.conditions))],
      equationIds: coefficients.map((x) => x.equation),
      coefficients,
      rhsProjection: nullVector.rhsProjection,
      eigenvalue: nullVector.eigenvalue,
    });
  }

  if (conflicts.length === 0 && bad.length > 0) {
    conflicts.push({ kind: 'residual', conditions: bad.map((x) => x.condition), residuals: bad });
  }

  const ids = [...new Set(conflicts.flatMap((c) => c.conditions ?? []))];
  return new UnsatisfiableConstraintsError('约束联合分布无解：部分条件无法共存', {
    conflicts,
    conditions: ids.length ? ids : bad.map((x) => x.condition),
    residuals,
    maxResidual: Math.max(...residuals.map((x) => Math.abs(x.residual)), 0),
    tolerance: model.conditionTolerance,
  });
}

function normalizeCallArgs(args) {
  if (args.length === 1) {
    const first = args[0];
    if (first instanceof CovarianceModel) return { model: first };
    if (Array.isArray(first)) return { conditions: first };
    return first ?? {};
  }
  const [first, second, third, fourth] = args;
  if (first instanceof CovarianceModel) {
    return { model: first, conditions: second ?? [], region: third, ...(fourth ?? {}) };
  }
  if (typeof first === 'string') {
    return {
      stamp: first,
      conditions: Array.isArray(second) || second == null ? (second ?? []) : [second],
      region: third,
      ...(fourth ?? {}),
    };
  }
  if (Array.isArray(first)) {
    return {
      conditions: first,
      region: second,
      ...(typeof third === 'string' ? { seed: third } : (third ?? {})),
    };
  }
  return { ...(first ?? {}), region: second ?? first?.region };
}

export function conditionAndSample(...callArgs) {
  const options = normalizeCallArgs(callArgs);
  const data = options.data ?? loadNoiseKeyData(options.dataUrl);
  const model = resolveModel(options, data);
  if (!model.available) {
    throw new MatrixUnavailableError('当前步的协方差模型/矩阵不可用', {
      model: model.identity(),
      reason: model.unavailableReason ?? 'model-marked-unavailable',
    });
  }
  if (!model.step && options.step) model.step = options.step;
  if (!model.basis && options.basis) model.basis = options.basis;

  const native =
    options.native ??
    new NativeNoiseSource({
      ...options,
      data,
      seed: options.seed ?? options.exampleSeed ?? data.seed,
      activeStep: model.step,
    });

  const rawConditions = normalizeManyConditions(options.conditions ?? [], {
    ...options,
    data,
    stamp: model.stamp,
    step: model.step,
    basis: model.basis,
  });
  const resolved = resolveConditionDuplicates(rawConditions, {
    covarianceTol: options.covarianceTol ?? model.covarianceTol,
  });

  const requestedRegion = options.region ?? options.indices ?? options.range ?? options.request;
  const diagnosticsOnly = options.diagnostics === true || options.allowEmptyRegion === true;
  if (requestedRegion === undefined && !diagnosticsOnly) {
    throw new MissingInputError('条件噪声采样需要请求 region/indices 小区域', {
      field: 'region',
      hint: '如果只校验/求解条件，请调用 validateConditions 或设置 diagnostics:true',
    });
  }
  const hasExplicitRegion = requestedRegion !== undefined;
  const indices = hasExplicitRegion
    ? normalizeRegion(requestedRegion, model.size, 'region')
    : [];

  const system = buildSystem({ model, native, equations: resolved.equations });
  const solution = solveWoodburyOrPseudo(system, model);
  const reader = createValueReader({ model, native, system, solution });

  const residualReport = rawConditions.map((condition) => {
    let sum = 0;
    for (const entry of condition.entries) sum += entry.weight * reader(entry.index).value;
    return { id: condition.id, identity: condition.identity, residual: sum - condition.value };
  });
  const maxResidual = residualReport.reduce((max, x) => Math.max(max, Math.abs(x.residual)), 0);
  if (maxResidual > model.conditionTolerance) {
    throw buildUnsatisfiableError({ solution, resolved, rawConditions, reader, model });
  }

  const reads = indices.map((index) => reader(index));
  const values = reads.map((x) => x.value);
  const unconditioned = reads.map((x) => x.unconditioned);
  const correction = reads.map((x) => x.correction);
  const nativeEpsilon = reads.map((x) => x.eps);
  const epsilonCorrection = reads.map((x) => x.deltaEpsilon);
  const stats = native.stats(model.step);
  const modelStats = model.stats();

  const conditionReport = rawConditions.map((c) => ({
    id: c.id,
    conditionId: c.conditionId,
    constraintId: c.constraintId,
    key: c.key,
    identity: c.identity,
    contentHash: c.contentHash,
    hash: c.hash,
    stamp: c.stamp ?? model.stamp,
    step: c.step ?? model.step,
    basis: c.basis ?? model.basis,
    patchId: c.patchId,
    indices: c.indices,
    value: c.value,
  }));

  const effectiveConditions = resolved.equations.map((e) => ({
    id: e.id,
    conditionIds: e.conditionIds,
    contentHashes: e.contentHashes,
    indices: e.entries.map((x) => x.index),
    weights: e.entries.map((x) => x.weight),
    value: e.value,
    duplicateCount: e.duplicateCount,
  }));

  const report = {
    ok: true,
    seed: native.seed,
    exampleSeed: options.exampleSeed ?? null,
    model: model.identity(),
    modelId: model.modelId,
    axisKey: model.axisKey,
    stamp: model.stamp,
    step: model.step,
    basis: model.basis,
    conditions: conditionReport,
    conditionIds: conditionReport.map((x) => x.id),
    effectiveConditions,
    effectiveConditionIds: [...new Set(effectiveConditions.flatMap((x) => x.conditionIds))],
    duplicates: resolved.duplicateGroups,
    duplicateGroups: resolved.duplicateGroups,
    rank: solution.mathRank,
    conditionRank: solution.mathRank,
    independentConditions: solution.mathRank,
    orthogonalCoordinates: solution.mathRank,
    randomCoordinates: solution.mathRank,
    addedRandomCoordinates: solution.mathRank,
    duplicateCoordinatesAdded: 0,
    solver: solution.solver,
    maxResidual,
    conditionTolerance: model.conditionTolerance,
    covarianceTol: model.covarianceTol,
    residualReport,
    fetch: { ...stats, ...modelStats },
    budget: {
      activeStep: stats.activeStep,
      latentFetch: stats.latentFetch,
      latentFetches: stats.latentFetches,
      fetchBudget: stats.fetchBudget,
      withinFetchBudget: stats.withinFetchBudget,
      nativeRetainedBytes: stats.retainedBytes,
      modelRowRetainedBytes: modelStats.rowRetainedBytes,
      totalRetainedBytes: stats.retainedBytes + modelStats.rowRetainedBytes,
      workBytesBudget: stats.workBytesBudget,
      withinWorkBytesBudget:
        stats.workBytesBudget == null
          ? true
          : stats.retainedBytes + modelStats.rowRetainedBytes <= stats.workBytesBudget,
      activeStepFetches: stats.activeStepFetches,
      activeStepRetained: stats.activeStepRetained,
      rowReads: modelStats.rowReads,
      cachedRows: modelStats.cachedRows,
    },
    nativeStats: stats,
    latentFetch: stats.latentFetch,
    latentFetches: stats.latentFetches,
    actualFetches: stats.actualFetches,
    rowReads: modelStats.rowReads,
    withinFetchBudget: stats.withinFetchBudget,
  };

  if (!hasExplicitRegion) {
    return { ...report, indices: [], values: [], unconditioned: [], correction: [] };
  }

  return {
    ...report,
    indices,
    region: requestedRegion,
    values,
    z: values,
    samples: values,
    sample: values,
    noise: values,
    output: values,
    data: values,
    unconditioned,
    native: unconditioned,
    nativeEpsilon,
    epsilonCorrection,
    deltaEta: Array.from(reader.deltaEta),
    correction,
    float64Values: Float64Array.from(values),
  };
}

export function sampleConditional(...args) {
  return conditionAndSample(...args);
}

export function validateConditions(options = {}) {
  return conditionAndSample({ ...options, diagnostics: true });
}

export function sampleBatch(options = {}) {
  const requests = options.requests ?? options.regions ?? options.batch;
  if (!Array.isArray(requests)) {
    throw new MissingInputError('sampleBatch 需要 requests 数组', { field: 'requests' });
  }
  const sharedReport = conditionAndSample({ ...options, requests: undefined, region: [] });
  const results = requests.map((request) => {
    const region =
      Array.isArray(request) || typeof request === 'number'
        ? request
        : (request.region ?? request.indices ?? request.range);
    const requestSeed =
      Array.isArray(request) || typeof request === 'number' ? undefined : request.seed;
    return conditionAndSample({
      ...options,
      region,
      seed: requestSeed ?? options.seed,
      exampleSeed: requestSeed ? (request.exampleSeed ?? requestSeed) : options.exampleSeed,
    });
  });
  return {
    ok: true,
    batch: results,
    batches: results,
    results,
    orderedValues: results.map((r) => r.values),
    sharedReport,
  };
}

export const batchSample = sampleBatch;
export const sampleBlocks = sampleBatch;
export const requestBatch = sampleBatch;
export const sampleRegions = sampleBatch;

export class ConditionalNoiseOperator {
  constructor(options = {}) {
    this.options = options;
    this.data = options.data ?? loadNoiseKeyData(options.dataUrl);
    this.model = resolveModel(options, this.data);
    this.native =
      options.native ??
      new NativeNoiseSource({
        data: this.data,
        seed: options.seed ?? options.exampleSeed ?? this.data.seed,
        activeStep: this.model.step,
      });
    this.definitions = options.definitions ?? createDefaultDefinitions(this.data);
    this.conditions = [];
    this.frame = null;
    this.lastReport = null;
  }

  submitFrame(frame = {}) {
    const imageId = frame.imageId ?? frame.pictureId ?? frame.id;
    const features = frame.features ?? frame.featureGrid ?? frame.featureCell;
    const pixels = frame.pixels ?? frame.constrainedPixels ?? frame.constraints;
    const covariance = frame.covarianceModel ?? frame.model ?? frame.covariance;
    const missing = [];
    if (imageId == null) missing.push('imageId');
    if (features == null) missing.push('featureGrid');
    if (pixels == null) missing.push('constrainedPixels');
    if (covariance == null && this.model == null) missing.push('covarianceModel');
    if (missing.length && (frame.strict === true || this.options.strictFrames === true)) {
      throw new MissingInputError(`编辑器提交缺少: ${missing.join(', ')}`, { missing });
    }
    if (covariance instanceof CovarianceModel) this.model = covariance;
    else if (covariance && typeof covariance === 'object') {
      this.model = resolveModel({ model: covariance, data: this.data }, this.data);
    }
    this.frame = {
      imageId: imageId ?? this.frame?.imageId ?? 'unidentified-image',
      features: features ?? this.frame?.features ?? null,
      featureIdentity:
        features == null ? null : sha256Hex(features).slice(0, 16),
      pixels: pixels ?? this.frame?.pixels ?? [],
      submittedAt: frame.submittedAt ?? new Date().toISOString(),
    };
    return this.frame;
  }

  addConditions(conditions) {
    const incoming = normalizeManyConditions(conditions, {
      data: this.data,
      definitions: this.definitions,
      stamp: this.model.stamp,
      step: this.model.step,
      basis: this.model.basis,
    });
    const merged = [...this.conditions, ...incoming];
    resolveConditionDuplicates(merged, { covarianceTol: this.model.covarianceTol });
    this.conditions = merged;
    return this.conditionReport();
  }

  addCondition(condition) {
    return this.addConditions([condition]);
  }

  setConditions(conditions) {
    const normalized = normalizeManyConditions(conditions, {
      data: this.data,
      definitions: this.definitions,
      stamp: this.model.stamp,
      step: this.model.step,
      basis: this.model.basis,
    });
    resolveConditionDuplicates(normalized, { covarianceTol: this.model.covarianceTol });
    this.conditions = normalized;
    return this.conditionReport();
  }

  clearConditions() {
    this.conditions = [];
    return this;
  }

  conditionReport() {
    const resolved = resolveConditionDuplicates(this.conditions, {
      covarianceTol: this.model.covarianceTol,
    });
    return {
      model: this.model.identity(),
      conditions: this.conditions.map((c) => ({
        id: c.id,
        identity: c.identity,
        contentHash: c.contentHash,
      })),
      effectiveConditions: resolved.equations,
      duplicates: resolved.duplicateGroups,
      rank: resolved.equations.length,
    };
  }

  request(region, options = {}) {
    const requestedSeed = options.seed ?? options.exampleSeed;
    if (requestedSeed != null && requestedSeed !== this.native.seed) {
      this.native.resetSeed(requestedSeed);
    }
    const result = conditionAndSample({
      ...this.options,
      ...options,
      data: this.data,
      model: this.model,
      native: this.native,
      seed: this.native.seed,
      conditions: [...this.conditions, ...(options.extraConditions ?? [])],
      region: region ?? options.region ?? options.indices,
      definitions: this.definitions,
    });
    this.lastReport = result;
    return result;
  }

  sample(region, options) {
    return this.request(region, options);
  }

  solve(region, options) {
    return this.request(region, options);
  }

  addConstraint(condition) {
    return this.addCondition(condition);
  }

  fetchRegion(region, options) {
    return this.request(region, options);
  }
}

export function createOperator(options) {
  return new ConditionalNoiseOperator(options);
}

export const conditionNoise = conditionAndSample;
export const conditionedNoise = conditionAndSample;
export const applyConditions = conditionAndSample;
export const solveConditionalNoise = conditionAndSample;
export const generateConditionalNoise = sampleConditional;
export const conditionalNoise = conditionAndSample;
export const computeConditionalNoise = conditionAndSample;
export const sampleNoise = sampleConditional;
export const conditionGaussian = conditionAndSample;
export const createConditionalNoiseOperator = createOperator;
export const createNoiseOperator = createOperator;
export const createNoiseConditioner = createOperator;
export const NoiseOperator = ConditionalNoiseOperator;
export const NoiseConditioner = ConditionalNoiseOperator;
export const ConditionalNoise = ConditionalNoiseOperator;
export const ConditionalGaussian = ConditionalNoiseOperator;
export const GaussianConditioner = ConditionalNoiseOperator;

export { ConditionalNoiseOperator as default };
