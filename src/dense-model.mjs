import { choleskyFactor } from './linalg.mjs';
import { MatrixUnavailableError } from './errors.mjs';

function matrixRows(input, size) {
  if (Array.isArray(input) && Array.isArray(input[0])) return input;
  if (ArrayBuffer.isView(input) || Array.isArray(input)) {
    const n = size ?? Math.sqrt(input.length);
    if (!Number.isInteger(n) || n * n !== input.length) {
      throw new MatrixUnavailableError('扁平协方差矩阵需要可确定的 size');
    }
    return Array.from({ length: n }, (_, i) =>
      Array.from({ length: n }, (_, j) => input[i * n + j]),
    );
  }
  throw new MatrixUnavailableError('无法识别的协方差矩阵输入');
}

/**
 * 小型自定义稠密协方差的兼容适配器：K = L L^T，
 * 以 z_i = Σ_k L_ik η_k 的零对角因子形式接入同一正交条件化核心。
 * 典型设备矩阵不会走这里，而是走 noiseRow 的 D/U 稀疏低秩路径。
 */
export function adaptDenseCovariance(spec = {}) {
  const covariance =
    spec.covarianceMatrix ?? spec.matrix ?? spec.K ?? spec.covariance ?? spec.values;
  let K;
  let n;

  if (typeof spec.covarianceEntry === 'function' || typeof spec.covariance === 'function') {
    n = spec.size ?? spec.cellCount ?? spec.grid?.reduce?.((a, b) => a * b, 1);
    if (!Number.isInteger(n)) {
      throw new MatrixUnavailableError('函数式协方差模型缺少 size/grid');
    }
    const fn = spec.covarianceEntry ?? spec.covariance;
    K = Array.from({ length: n }, (_, i) =>
      Float64Array.from({ length: n }, (_, j) => Number(fn(i, j))),
    );
  } else if (covariance != null) {
    K = matrixRows(covariance, spec.size);
    n = K.length;
  } else {
    return spec;
  }

  const factor = choleskyFactor(K, { tolerance: spec.covarianceTol ?? 1e-10 });
  if (factor.singular) {
    throw new MatrixUnavailableError('协方差矩阵不是数值正定矩阵，无法构造兼容因子', {
      index: factor.index,
      value: factor.value,
    });
  }
  const L = factor.L;
  return {
    ...spec,
    grid: spec.grid ?? [n],
    rank: n,
    dense: true,
    rowProvider: (index) => ({ d: 0, u: L[index] }),
  };
}
