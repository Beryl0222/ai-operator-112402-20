import { sampleConditional } from './condition-operator.mjs';

export function errorStatus(error) {
  const code = String(error?.code ?? '');
  const codes = Array.isArray(error?.codes) ? error.codes : [];
  if (code.includes('MATRIX_UNAVAILABLE') || codes.some((c) => String(c).includes('MATRIX_UNAVAILABLE') || c === 'COVARIANCE_UNAVAILABLE')) {
    return 'matrix-unavailable';
  }
  if (code.includes('UNSATISFIABLE') || codes.some((c) => String(c).includes('UNSATISFIABLE'))) {
    return 'unsatisfiable';
  }
  if (code.includes('MISSING_INPUT') || codes.some((c) => String(c).includes('MISSING_INPUT'))) {
    return 'missing-input';
  }
  if (code === 'STEP_RESOLUTION_REQUIRED') return 'step-resolution-required';
  if (code === 'CROSS_STAMP_CONDITION') return 'cross-stamp-condition';
  return 'error';
}

export function serializeError(error) {
  if (!(error instanceof Error)) return { name: 'Error', message: String(error) };
  return {
    name: error.name,
    code: error.code,
    codes: error.codes,
    status: errorStatus(error),
    message: error.message,
    conditions: error.conditions,
    conflicts: error.conflicts,
    choices: error.choices,
    missing: error.missing,
    fromStamp: error.fromStamp,
    toStamp: error.toStamp,
  };
}

/** 不抛异常的调用入口：用 status 区分三类核心失败。 */
export function evaluateConditionalNoise(options = {}) {
  try {
    const result = sampleConditional(options);
    return { ok: true, status: 'ok', result, ...result };
  } catch (error) {
    return {
      ok: false,
      status: errorStatus(error),
      ...serializeError(error),
      error: serializeError(error),
    };
  }
}

export const trySampleConditional = evaluateConditionalNoise;

export async function evaluateConditionalNoiseAsync(options = {}) {
  return evaluateConditionalNoise(options);
}

export function createJsonRpcHandler() {
  return async function handle(message) {
    const id = message?.id ?? null;
    const method = message?.method;
    const params = message?.params ?? {};
    try {
      if (method === 'noise.evaluate' || method === 'noise.sample') {
        return { jsonrpc: '2.0', id, result: evaluateConditionalNoise(params) };
      }
      if (method === 'noise.health') {
        return { jsonrpc: '2.0', id, result: { ok: true } };
      }
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
    } catch (error) {
      return { jsonrpc: '2.0', id, error: { code: -32000, ...serializeError(error) } };
    }
  };
}
