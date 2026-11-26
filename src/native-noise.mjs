import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const DEFAULT_NOISE_KEY_URL = new URL('../inputs/noise-key.json', import.meta.url);

let cachedInputData;
export function loadNoiseKeyData(url = DEFAULT_NOISE_KEY_URL) {
  if (url === DEFAULT_NOISE_KEY_URL && cachedInputData) return cachedInputData;
  const data = JSON.parse(readFileSync(url, 'utf8'));
  if (url === DEFAULT_NOISE_KEY_URL) cachedInputData = data;
  return data;
}

export function sha256Hex(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return createHash('sha256').update(text).digest('hex');
}

export function canonicalIdentity(value) {
  return sha256Hex(value);
}

/**
 * 与 inputs/noise-key.mjs 完全相同的 SHA-256 + Box-Muller 解释，
 * 但允许调用方给出示例 seed，并统计实际读过/留存的原生坐标。
 */
export function nativeNormalValue({ seed, step, component, index }) {
  const hash = createHash('sha256')
    .update(JSON.stringify([seed, step, component, index]))
    .digest();
  const u = (hash.readUInt32BE(0) + 0.5) / 4294967296;
  const v = (hash.readUInt32BE(4) + 0.5) / 4294967296;
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export class NativeNoiseSource {
  constructor(options = {}) {
    const data = options.data ?? loadNoiseKeyData(options.dataUrl);
    this.data = data;
    this.seed = options.seed ?? data.seed;
    this.budget = options.budget ?? data.latentFetch ?? null;
    this.workBytesBudget = options.workBytesBudget ?? data.workBytes ?? null;
    this.normalProvider = options.normal ?? options.noiseNormal ?? null;
    this._cache = new Map();
    this.readCalls = 0;
    this.uniqueFetches = 0;
    this.byStep = new Map();
    this.activeStep = options.activeStep ?? null;
  }

  _stepStat(step) {
    let stat = this.byStep.get(step);
    if (!stat) {
      stat = { step, readCalls: 0, fetches: 0, coordinates: 0, retainedValues: 0 };
      this.byStep.set(step, stat);
    }
    return stat;
  }

  has(step, component, index) {
    return this._cache.has(JSON.stringify([step, component, index]));
  }

  resetSeed(seed = this.seed) {
    if (seed !== this.seed) {
      this.seed = seed;
      this._cache.clear();
      this.readCalls = 0;
      this.uniqueFetches = 0;
      this.byStep.clear();
      this.activeStep = null;
    }
    return this;
  }

  fork(seed = this.seed) {
    return new NativeNoiseSource({
      data: this.data,
      seed,
      budget: this.budget,
      workBytesBudget: this.workBytesBudget,
    });
  }

  normal(step, component, index) {
    this.readCalls += 1;
    if (this.activeStep == null) this.activeStep = step;
    const stat = this._stepStat(step);
    stat.readCalls += 1;

    const key = JSON.stringify([step, component, index]);
    const cached = this._cache.get(key);
    if (cached !== undefined) return cached;

    const value = this.normalProvider
      ? this.normalProvider(step, component, index)
      : nativeNormalValue({ seed: this.seed, step, component, index });
    this._cache.set(key, value);
    this.uniqueFetches += 1;
    stat.fetches += 1;
    stat.coordinates += 1;
    stat.retainedValues += 1;
    return value;
  }

  /** 设备实际取数/留存统计。重复读取同一坐标不会重复取数。 */
  stats(activeStep = this.activeStep) {
    const stepStat = activeStep ? this.byStep.get(activeStep) : undefined;
    const retainedCoordinates = this._cache.size;
    const retainedBytes = retainedCoordinates * 8;
    const active = stepStat
      ? { ...stepStat, retainedBytes: stepStat.retainedValues * 8 }
      : null;
    return {
      seed: this.seed,
      activeStep,
      readCalls: this.readCalls,
      // latentFetch(s) 是实际原生潜变量取数指标；latentFetchBudget 是输入预算。
      latentFetch: this.uniqueFetches,
      latentFetches: this.uniqueFetches,
      uniqueFetches: this.uniqueFetches,
      actualFetches: this.uniqueFetches,
      retainedCoordinates,
      retainedValues: retainedCoordinates,
      retainedBytes,
      budget: this.budget,
      fetchBudget: this.budget,
      latentFetchBudget: this.budget,
      withinFetchBudget: this.budget == null ? true : this.uniqueFetches <= this.budget,
      workBytesBudget: this.workBytesBudget,
      withinWorkBytesBudget:
        this.workBytesBudget == null ? true : retainedBytes <= this.workBytesBudget,
      activeStepReads: stepStat?.readCalls ?? 0,
      activeStepFetches: stepStat?.fetches ?? 0,
      activeStepRetained: stepStat?.retainedValues ?? 0,
      activeStepRetainedBytes: stepStat ? stepStat.retainedValues * 8 : 0,
      active,
      steps: [...this.byStep.values()].map((x) => ({ ...x })),
    };
  }
}

export function createNativeNoiseSource(options) {
  return new NativeNoiseSource(options);
}
