/**
 * 三类调用方需要区分的失败，以及跨步次身份错误。
 * code 同时保留常见英文别名，便于不同调用层识别。
 */
export class NoiseOperatorError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'NoiseOperatorError';
    if (details && typeof details === 'object') Object.assign(this, details);
  }
}

export class UnsatisfiableConstraintsError extends NoiseOperatorError {
  constructor(message = '约束不存在相容解', details = {}) {
    super(message, details);
    this.name = 'UnsatisfiableConstraintsError';
    this.code = 'CONSTRAINTS_UNSATISFIABLE';
    this.codes = [
      'CONSTRAINTS_UNSATISFIABLE',
      'UNSATISFIABLE_CONSTRAINTS',
      'ERR_CONSTRAINTS_UNSATISFIABLE',
    ];
    if (!Array.isArray(this.conditions)) this.conditions = [];
    if (!Array.isArray(this.conflicts)) this.conflicts = [];
    this.conditionIds = this.conditions;
    this.conflictingConditionIds = this.conditions;
    this.incompatibleConditions = this.conditions;
    this.status = 'unsatisfiable';
  }
}

export class MatrixUnavailableError extends NoiseOperatorError {
  constructor(message = '协方差矩阵或模型行不可用', details = {}) {
    super(message, details);
    this.name = 'MatrixUnavailableError';
    this.code = 'MATRIX_UNAVAILABLE';
    this.codes = ['MATRIX_UNAVAILABLE', 'COVARIANCE_UNAVAILABLE', 'ERR_MATRIX_UNAVAILABLE'];
    this.status = 'matrix-unavailable';
  }
}

export class MissingInputError extends NoiseOperatorError {
  constructor(message = '缺少必要输入', details = {}) {
    super(message, details);
    this.name = 'MissingInputError';
    this.code = 'MISSING_INPUT';
    this.codes = ['MISSING_INPUT', 'MISSING_INPUT_ERROR', 'ERR_MISSING_INPUT'];
    this.status = 'missing-input';
  }
}

export class StepResolutionRequiredError extends NoiseOperatorError {
  constructor(message = '旧条件缺少可确认的模型步次', details = {}) {
    super(message, details);
    this.name = 'StepResolutionRequiredError';
    this.code = 'STEP_RESOLUTION_REQUIRED';
    this.codes = ['STEP_RESOLUTION_REQUIRED', 'UNKNOWN_STEP', 'AMBIGUOUS_STEP'];
    this.choices = ['rebuild', 'history'];
    this.options = this.choices;
    this.actions = this.choices;
    this.status = 'step-resolution-required';
  }
}

export class CrossStampConditionError extends NoiseOperatorError {
  constructor(message = '不能把其他步次的条件实例直接移到当前步', details = {}) {
    super(message, details);
    this.name = 'CrossStampConditionError';
    this.code = 'CROSS_STAMP_CONDITION';
    this.codes = ['CROSS_STAMP_CONDITION', 'WRONG_STAMP', 'STEP_MISMATCH'];
    this.status = 'cross-stamp-condition';
  }
}

export function isErrorCode(error, ...codes) {
  if (!error) return false;
  const wanted = new Set(codes);
  if (wanted.has(error.code)) return true;
  return Array.isArray(error.codes) && error.codes.some((code) => wanted.has(code));
}
