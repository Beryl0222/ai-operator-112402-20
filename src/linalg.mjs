/** 小规模稠密线性代数。典型 tile 路径走稀疏 S + rank-r 的 Woodbury，
 *  只有出现秩亏/复杂重叠时才进入 Jacobi 特征分解兜底。
 */

export function choleskyFactor(matrix, options = {}) {
  const n = matrix.length;
  const tol = options.tolerance ?? 1e-10;
  let maxDiag = 0;
  for (let i = 0; i < n; i += 1) maxDiag = Math.max(maxDiag, Math.abs(matrix[i][i]));
  const threshold = tol * Math.max(1, maxDiag);

  const L = Array.from({ length: n }, () => new Float64Array(n));
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j <= i; j += 1) {
      let sum = matrix[i][j];
      for (let k = 0; k < j; k += 1) sum -= L[i][k] * L[j][k];
      if (i === j) {
        if (!(sum > threshold)) {
          return { singular: true, index: i, value: sum, threshold, L };
        }
        L[i][i] = Math.sqrt(sum);
      } else {
        L[i][j] = sum / L[j][j];
      }
    }
  }
  return { singular: false, L, threshold };
}

/** B 为 n×p；返回同形状解。 */
export function solveCholesky(L, B) {
  const n = L.length;
  const p = B[0]?.length ?? 0;
  const X = Array.from({ length: n }, () => new Float64Array(p));

  for (let col = 0; col < p; col += 1) {
    const y = new Float64Array(n);
    for (let i = 0; i < n; i += 1) {
      let sum = B[i][col];
      for (let k = 0; k < i; k += 1) sum -= L[i][k] * y[k];
      y[i] = sum / L[i][i];
    }
    for (let i = n - 1; i >= 0; i -= 1) {
      let sum = y[i];
      for (let k = i + 1; k < n; k += 1) sum -= L[k][i] * X[k][col];
      X[i][col] = sum / L[i][i];
    }
  }
  return X;
}

export function solveSPD(A, rhs, tolerance = 1e-10) {
  const factor = choleskyFactor(A, { tolerance });
  if (factor.singular) return { singular: true, factor };
  const B = rhs.map((value) => [value]);
  const X = solveCholesky(factor.L, B);
  return { singular: false, x: X.map((row) => row[0]), L: factor.L };
}

/** 对称矩阵 Jacobi 特征分解；结果确定，不依赖平台 BLAS 线程归约顺序。 */
export function jacobiEigen(input, options = {}) {
  const n = input.length;
  const maxSweeps = options.maxSweeps ?? 100;
  const tolerance = options.tolerance ?? 1e-14;
  const A = input.map((row) => Float64Array.from(row));
  const V = Array.from({ length: n }, (_, i) =>
    Float64Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
  );

  let scale = 0;
  for (let i = 0; i < n; i += 1) scale = Math.max(scale, Math.abs(A[i][i]));
  scale = Math.max(scale, 1);

  for (let sweep = 0; sweep < maxSweeps; sweep += 1) {
    let off = 0;
    for (let p = 0; p < n; p += 1) {
      for (let q = p + 1; q < n; q += 1) off += A[p][q] * A[p][q];
    }
    if (Math.sqrt(off) <= tolerance * scale * n) break;

    for (let p = 0; p < n; p += 1) {
      for (let q = p + 1; q < n; q += 1) {
        const apq = A[p][q];
        if (Math.abs(apq) <= tolerance * scale) continue;
        const app = A[p][p];
        const aqq = A[q][q];
        const tau = (aqq - app) / (2 * apq);
        const t = (tau >= 0 ? 1 : -1) / (Math.abs(tau) + Math.sqrt(1 + tau * tau));
        const c = 1 / Math.sqrt(1 + t * t);
        const s = t * c;

        A[p][p] = app - t * apq;
        A[q][q] = aqq + t * apq;
        A[p][q] = 0;
        A[q][p] = 0;

        for (let i = 0; i < n; i += 1) {
          if (i === p || i === q) continue;
          const aip = A[i][p];
          const aiq = A[i][q];
          A[i][p] = aip - s * (aiq + tau * aip);
          A[p][i] = A[i][p];
          A[i][q] = aiq + s * (aip - tau * aiq);
          A[q][i] = A[i][q];
        }

        for (let i = 0; i < n; i += 1) {
          const vip = V[i][p];
          const viq = V[i][q];
          V[i][p] = vip - s * (viq + tau * vip);
          V[i][q] = viq + s * (vip - tau * viq);
        }
      }
    }
  }

  return {
    eigenvalues: A.map((row, i) => row[i]),
    eigenvectors: V,
  };
}

/**
 * Moore–Penrose 风格的对称伪逆求解。
 * rankTol 使用调用方的 covarianceTol 做相对尺度控制。
 */
export function pseudoinverseSolve(M, rhs, covarianceTol = 1e-8) {
  const n = M.length;
  if (n === 0) return { y: [], rank: 0, nullVectors: [], residualNorm: 0 };
  const { eigenvalues, eigenvectors: V } = jacobiEigen(M, {
    tolerance: Math.min(1e-13, covarianceTol / 100),
  });
  const lambdaMax = Math.max(...eigenvalues.map((x) => Math.abs(x)), 0);
  const cutoff = covarianceTol * Math.max(1, lambdaMax);
  const y = new Float64Array(n);
  let rank = 0;
  const nullVectors = [];

  for (let k = 0; k < n; k += 1) {
    const lambda = eigenvalues[k];
    const v = Array.from({ length: n }, (_, i) => V[i][k]);
    const dot = v.reduce((sum, vi, i) => sum + vi * rhs[i], 0);
    if (lambda > cutoff) {
      rank += 1;
      const coeff = dot / lambda;
      for (let i = 0; i < n; i += 1) y[i] += coeff * v[i];
    } else {
      nullVectors.push({ eigenvalue: lambda, vector: v, rhsProjection: dot });
    }
  }

  const residual = new Float64Array(n);
  let residualNorm = 0;
  for (let i = 0; i < n; i += 1) {
    let my = 0;
    for (let j = 0; j < n; j += 1) my += M[i][j] * y[j];
    residual[i] = my - rhs[i];
    residualNorm += residual[i] * residual[i];
  }
  return { y: Array.from(y), rank, nullVectors, residual: Array.from(residual), residualNorm: Math.sqrt(residualNorm), cutoff, lambdaMax };
}

export function dot(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += a[i] * b[i];
  return sum;
}
