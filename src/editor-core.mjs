import {
  CrossStampConditionError,
  MissingInputError,
  StepResolutionRequiredError,
} from './errors.mjs';
import { normalizeCondition } from './conditions.mjs';
import { CovarianceModel, createStampModel } from './model.mjs';
import { NativeNoiseSource, loadNoiseKeyData, sha256Hex } from './native-noise.mjs';
import { ConditionalNoiseOperator, createDefaultDefinitions, resolveModel } from './condition-operator.mjs';

function canonicalRegion(region) {
  if (Array.isArray(region) && region.length === 2 && region.every(Number.isInteger)) {
    return `[${region[0]},${region[1]})`;
  }
  if (typeof region === 'number') return String(region);
  if (Array.isArray(region)) return `indices:${region.join(',')}`;
  return sha256Hex(region).slice(0, 16);
}

function patchIdentity(condition) {
  if (condition.patchId) return String(condition.patchId);
  return `patch-${sha256Hex(condition.indices).slice(0, 12)}`;
}

export class NoiseEditor {
  constructor(options = {}) {
    this.data = options.data ?? loadNoiseKeyData(options.dataUrl);
    this.seed = options.seed ?? options.exampleSeed ?? this.data.seed;
    this.native = options.native ?? new NativeNoiseSource({ data: this.data, seed: this.seed });
    this.definitions = options.definitions ?? createDefaultDefinitions(this.data);
    this.sessions = new Map();
    this.globalFrame = null;
    this.legacy = new Map();
    this.events = [];
    if (options.stamps) for (const stamp of options.stamps) this.getStamp(stamp);
  }

  getStamp(stampId, modelOptions = {}) {
    if (stampId instanceof CovarianceModel) {
      const model = stampId;
      const id = model.stamp ?? model.modelId;
      if (this.sessions.has(id)) return this.sessions.get(id);
      const operator = new ConditionalNoiseOperator({
        data: this.data,
        model,
        native: this.native,
        definitions: this.definitions,
      });
      return this._createSession(id, model, operator);
    }

    const existing = this.sessions.get(stampId);
    if (existing && !modelOptions.model && !modelOptions.covarianceModel) return existing;

    let model;
    if (modelOptions.model instanceof CovarianceModel) model = modelOptions.model;
    else if (modelOptions.covarianceModel instanceof CovarianceModel) model = modelOptions.covarianceModel;
    else if (modelOptions.covarianceModel || modelOptions.model) {
      model = resolveModel(
        {
          stamp: typeof stampId === 'string' ? stampId : undefined,
          data: this.data,
          ...modelOptions,
          covarianceModel: modelOptions.covarianceModel ?? modelOptions.model,
        },
        this.data,
      );
    } else {
      const known = this.data.stamps?.some((s) => s[0] === stampId);
      if (!known && !modelOptions.step && !modelOptions.grid) {
        throw new StepResolutionRequiredError(`未知或缺少模型步次: ${String(stampId)}`, {
          stamp: stampId,
          choices: ['rebuild', 'history'],
        });
      }
      model = createStampModel(stampId, { data: this.data, ...modelOptions });
    }

    const operator = new ConditionalNoiseOperator({
      data: this.data,
      model,
      native: this.native,
      definitions: this.definitions,
    });
    const session = this._createSession(stampId, model, operator);
    this.sessions.set(stampId, session);
    return session;
  }

  _createSession(stampId, model, operator) {
    const session = {
      stamp: stampId,
      model,
      operator,
      conditions: new Map(),
      accepted: new Map(),
      patches: new Map(),
      history: [],
      versions: new Map(),
      frame: null,
      seq: 0,
      lastCommit: null,
    };
    this.sessions.set(stampId, session);
    return session;
  }

  submitFrame(stampOrFrame, maybeFrame) {
    let stampId = null;
    let frame = maybeFrame;
    if (maybeFrame === undefined && typeof stampOrFrame === 'object' && stampOrFrame !== null) {
      frame = stampOrFrame;
      stampId = frame.stamp ?? frame.stampId ?? frame.currentStamp ?? null;
    } else {
      stampId = stampOrFrame;
    }

    const hasPixels = frame.constrainedPixels !== undefined || frame.pixels !== undefined;
    const normalizedFrame = {
      imageId: frame.imageId ?? frame.pictureId ?? frame.id,
      featureGrid: frame.featureGrid ?? frame.features ?? frame.featureCell ?? null,
      constrainedPixels: frame.constrainedPixels ?? frame.pixels ?? [],
      covarianceModel: frame.covarianceModel ?? frame.model ?? null,
      submittedAt: new Date().toISOString(),
    };
    if (normalizedFrame.imageId == null) {
      throw new MissingInputError('提交缺少画面身份 imageId', { missing: ['imageId'] });
    }
    if (normalizedFrame.featureGrid == null) {
      throw new MissingInputError('提交缺少特征格 featureGrid', { missing: ['featureGrid'] });
    }
    if (!hasPixels) {
      throw new MissingInputError('提交缺少约束像素 constrainedPixels', {
        missing: ['constrainedPixels'],
      });
    }
    if (stampId == null) {
      const covariance = normalizedFrame.covarianceModel;
      stampId =
        frame.step ??
        frame.currentStep ??
        covariance?.stamp ??
        covariance?.stampId ??
        (covariance?.step ? `${covariance.step}:${covariance.basis ?? 'default'}` : null);
    }
    if (stampId == null) {
      this.globalFrame = normalizedFrame;
      return { ok: true, scope: 'global', frame: this.globalFrame };
    }
    let session = this.sessions.get(stampId);
    if (!session) {
      const modelOptions =
        normalizedFrame.covarianceModel && typeof normalizedFrame.covarianceModel === 'object'
          ? normalizedFrame.covarianceModel
          : { step: frame.step, basis: frame.basis, grid: frame.grid ?? frame.featureGrid?.grid };
      session = this.getStamp(stampId, { covarianceModel: modelOptions });
    }
    session.frame = normalizedFrame;

    let appliedConditions = [];
    if (frame.applyConstraints !== false && normalizedFrame.constrainedPixels.length > 0) {
      const specs = this._pixelConditionSpecs(normalizedFrame.constrainedPixels);
      for (const spec of specs) {
        const result = this.condition(stampId, spec, { source: 'submitFrame' });
        appliedConditions.push(result.condition.id);
      }
    }
    return {
      ok: true,
      scope: 'stamp',
      stamp: stampId,
      frame: normalizedFrame,
      appliedConditions,
      conditionIds: appliedConditions,
    };
  }

  _pixelConditionSpecs(pixels) {
    const list = Array.isArray(pixels) ? pixels : Object.entries(pixels).map(([index, value]) => ({ index: Number(index), value }));
    return list.map((pixel, i) => {
      if (Array.isArray(pixel)) {
        if (pixel.length === 2 && typeof pixel[0] === 'number') {
          return { id: `pixel-${pixel[0]}`, indices: [pixel[0]], weights: [1], value: pixel[1] };
        }
        return pixel; // 完整 tuple [id, indices, weights, value]
      }
      if (pixel.indices || pixel.weights || pixel.coefficients) return pixel;
      const index = pixel.index ?? pixel.pixel ?? pixel.i ?? pixel[0];
      const value = pixel.value ?? pixel.b ?? pixel.pixelValue ?? pixel[1];
      if (index == null || value == null) {
        throw new MissingInputError('约束像素需要 index/value', { pixel });
      }
      return {
        id: pixel.id ?? pixel.conditionId ?? `pixel-${index}`,
        indices: [index],
        weights: [pixel.weight ?? 1],
        value,
        patchId: pixel.patchId,
      };
    });
  }

  _resolveConditionInput(stampId, input, options = {}) {
    const session = this.getStamp(stampId, options);
    let candidate = input;
    if (typeof input === 'string') {
      const active = session.conditions.get(input);
      if (active && !options.forceDefinition) return active;
      const definition = options.definitions?.get?.(input) ?? this.definitions.get(input);
      if (!definition) {
        const elsewhere = this._findConditionEverywhere(input);
        if (elsewhere) {
          throw new CrossStampConditionError(
            `条件 ${input} 属于 ${elsewhere.stamp}，不能直接移到 ${stampId}`,
            { conditionId: input, fromStamp: elsewhere.stamp, toStamp: stampId },
          );
        }
        throw new MissingInputError(`找不到条件: ${input}`, { conditionId: input });
      }
      candidate = definition;
    }

    const normalized = normalizeCondition(candidate, {
      data: this.data,
      definitions: this.definitions,
      stamp: session.model.stamp,
      step: session.model.step,
      basis: session.model.basis,
      ...options,
    });

    if (normalized.step == null && normalized.stamp == null && options.allowUnknownStep !== true) {
      this.legacy.set(normalized.id, { condition: normalized, status: 'unknown-step' });
      throw new StepResolutionRequiredError(`条件 ${normalized.id} 的获取步次未知`, {
        conditionId: normalized.id,
        choices: ['rebuild', 'history'],
        condition: normalized,
      });
    }
    return normalized;
  }

  _findConditionEverywhere(conditionId) {
    for (const [stamp, session] of this.sessions) {
      const condition = session.conditions.get(conditionId);
      if (condition) return { stamp, condition };
    }
    return null;
  }

  condition(stampId, input, options = {}) {
    if (stampId && typeof stampId === 'object' && !(stampId instanceof CovarianceModel)) {
      const arg = stampId;
      options = { ...arg, ...options };
      stampId = arg.stamp ?? arg.stampId ?? arg.currentStamp;
      input =
        arg.condition ??
        arg.constraint ??
        (arg.indices || arg.entries || arg.weights ? arg : (arg.target ?? arg.id ?? arg));
    }
    const session = this.getStamp(stampId, options);
    const normalized = this._resolveConditionInput(stampId, input, options);
    const before = session.operator.conditions.length;
    const duplicateOfExisting = session.operator.conditions.some(
      (c) =>
        c.id === normalized.id || c.canonical?.signature === normalized.canonical?.signature,
    );
    const report = session.operator.addCondition(normalized);
    const added = session.operator.conditions[session.operator.conditions.length - 1];
    session.conditions.set(added.id, added);
    this.events.push({ type: 'condition', stamp: stampId, conditionId: added.id, at: Date.now() });
    return {
      ok: true,
      stamp: stampId,
      model: session.model.identity(),
      condition: {
        id: added.id,
        identity: added.identity,
        contentHash: added.contentHash,
        patchId: patchIdentity(added),
        indices: added.indices,
        value: added.value,
      },
      duplicate: duplicateOfExisting,
      alreadyEffective: duplicateOfExisting,
      coordinateAdded: !duplicateOfExisting,
      randomCoordinatesAdded: duplicateOfExisting ? 0 : 1,
      added: !duplicateOfExisting && session.operator.conditions.length > before,
      report,
    };
  }

  add(stampId, input, options) {
    return this.condition(stampId, input, options);
  }

  commit(stampId, target, options = {}) {
    if (stampId && typeof stampId === 'object' && !(stampId instanceof CovarianceModel)) {
      const arg = stampId;
      if (
        (arg.imageId || arg.featureGrid || arg.constrainedPixels) &&
        !arg.indices &&
        !arg.condition &&
        !arg.constraint &&
        !(arg.id && this.definitions.has?.(arg.id))
      ) {
        const frameResult = this.submitFrame(arg);
        return { ok: true, committed: true, ...frameResult };
      }
      options = { ...arg, ...(target && typeof target === 'object' ? target : {}) };
      target =
        arg.condition ??
        arg.constraint ??
        (arg.indices || arg.entries || arg.weights ? arg : (arg.target ?? arg.id ?? arg));
      stampId = arg.stamp ?? arg.stampId ?? arg.currentStamp;
    }
    if (
      target &&
      typeof target === 'object' &&
      !Array.isArray(target) &&
      (target.imageId || target.featureGrid || target.constrainedPixels)
    ) {
      this.submitFrame(stampId, target);
    }
    const result = this.condition(stampId, target, { ...options, commit: true });
    const session = this.getStamp(stampId);
    const commitRecord = {
      committedAt: new Date().toISOString(),
      stamp: stampId,
      conditionId: result.condition.id,
      conditionIdentity: result.condition.identity,
      modelIdentity: session.model.identity(),
    };
    session.lastCommit = commitRecord;
    return { ...result, committed: true, commit: commitRecord };
  }

  accept(stampId, target, options = {}) {
    if (stampId && typeof stampId === 'object' && !(stampId instanceof CovarianceModel)) {
      const arg = stampId;
      options = { ...arg, ...(target && typeof target === 'object' ? target : {}) };
      target = arg.target ?? arg.condition ?? arg.versionId ?? arg.patch ?? arg.id ?? arg;
      stampId = arg.stamp ?? arg.stampId ?? arg.currentStamp;
    }
    const session = this.getStamp(stampId, options);
    const targetId = typeof target === 'string' ? target : target?.id ?? target?.conditionId;
    let condition = targetId ? session.conditions.get(targetId) : null;
    const conditionAlreadyEffective = Boolean(condition);

    if (!condition && typeof target === 'string' && session.versions.has(target)) {
      return this.acceptVersion(stampId, target, options);
    }

    if (
      !condition &&
      target &&
      typeof target === 'object' &&
      (target.versionId || (Array.isArray(target.values) && Array.isArray(target.indices)))
    ) {
      const version = target.versionId
        ? session.versions.get(target.versionId)
        : {
            versionId: options.versionId ?? 'inline-display',
            indices: target.indices,
            values: target.values,
          };
      if (version) return this.acceptDisplayedValues(stampId, version, options);
    }

    if (!condition && target && typeof target === 'object') {
      condition = this._resolveConditionInput(stampId, target, options);
      session.operator.addCondition(condition);
      session.conditions.set(condition.id, condition);
    }

    if (!condition && targetId) {
      const elsewhere = this._findConditionEverywhere(targetId);
      if (elsewhere) {
        throw new CrossStampConditionError(
          `不能把 ${elsewhere.stamp} 上的条件 ${targetId} 移到 ${stampId}；请在当前步重建`,
          { conditionId: targetId, fromStamp: elsewhere.stamp, toStamp: stampId },
        );
      }
      if (this.definitions.has(targetId) && options.applyDefinition !== false) {
        const result = this.condition(stampId, targetId, options);
        condition = session.conditions.get(result.condition.id);
      }
    }

    if (!condition) {
      throw new MissingInputError(`accept 目标不在有效条件集中: ${String(targetId)}`, {
        stamp: stampId,
        target: targetId,
      });
    }

    const patchId = options.patchId ?? patchIdentity(condition);
    const patch = {
      patchId,
      conditionId: condition.id,
      conditionIdentity: condition.identity,
      indices: condition.indices,
      span: [condition.indices[0], condition.indices.at(-1) + 1],
      contentHash: sha256Hex(condition.indices).slice(0, 16),
    };
    session.patches.set(patchId, patch);

    const existing = session.accepted.get(condition.id);
    if (existing) {
      return {
        ok: true,
        accepted: true,
        alreadyEffective: true,
        conditionAlreadyEffective: true,
        alreadyAccepted: true,
        acceptanceExisted: true,
        acceptance: existing,
        conditionId: condition.id,
        conditionIdentity: condition.identity,
        patchId: existing.patchId,
        patch: existing.patch,
        rankUnchanged: true,
      };
    }

    const acceptance = {
      acceptedAt: new Date().toISOString(),
      stamp: stampId,
      conditionId: condition.id,
      conditionIdentity: condition.identity,
      patchId,
      patch,
    };
    session.accepted.set(condition.id, acceptance);
    this.events.push({ type: 'accept', stamp: stampId, conditionId: condition.id, patchId });
    return {
      ok: true,
      accepted: true,
      alreadyEffective: conditionAlreadyEffective,
      conditionAlreadyEffective,
      alreadyAccepted: false,
      acceptanceExisted: false,
      acceptance,
      conditionId: condition.id,
      conditionIdentity: condition.identity,
      patchId,
      patch,
      rankUnchanged: conditionAlreadyEffective,
    };
  }

  acceptVersion(stampId, versionId, options = {}) {
    const session = this.getStamp(stampId, options);
    const version = session.versions.get(versionId);
    if (!version) {
      throw new MissingInputError(`当前步找不到展示版本: ${String(versionId)}`, {
        stamp: stampId,
        versionId,
        code: 'VERSION_NOT_FOUND',
      });
    }
    return this.acceptDisplayedValues(stampId, version, options);
  }

  acceptDisplayedValues(stampId, version, options = {}) {
    const session = this.getStamp(stampId, options);
    if (!version || !Array.isArray(version.indices) || !Array.isArray(version.values)) {
      throw new MissingInputError('接受展示值需要 indices/values 或 versionId', { field: 'version' });
    }

    let selectedIndices = options.indices ?? options.pixelIndices ?? null;
    if (!selectedIndices && options.mask) {
      selectedIndices = version.indices.filter((_, i) => options.mask[i]);
    }
    if (!selectedIndices && Array.isArray(options.pixels)) selectedIndices = options.pixels;
    const indices = selectedIndices
      ? selectedIndices.map(Number).sort((a, b) => a - b)
      : [...version.indices].sort((a, b) => a - b);
    const valueByIndex = new Map(version.indices.map((index, i) => [index, version.values[i]]));
    for (const index of indices) {
      if (!valueByIndex.has(index)) {
        throw new MissingInputError('要接受的像素不在已展示版本中', { index, versionId: version.versionId });
      }
    }

    const prefix = options.conditionPrefix ?? `accepted:${version.versionId ?? 'display'}`;
    const specs = indices.map((index) => ({
      id: options.ids?.[index] ?? `${prefix}:${index}`,
      indices: [index],
      weights: [options.weight ?? 1],
      value: valueByIndex.get(index),
      sourceVersion: version.versionId ?? null,
      patchId: options.patchId,
    }));
    const patchId =
      options.patchId ??
      `accepted-${sha256Hex({ v: version.versionId, indices }).slice(0, 12)}`;

    const existingAcceptance = session.accepted.get(patchId);
    if (existingAcceptance && !options.force) {
      return {
        ok: true,
        accepted: true,
        alreadyEffective: true,
        acceptance: existingAcceptance,
        patchId,
        patch: existingAcceptance.patch,
        conditionIds: existingAcceptance.conditionIds,
        rankUnchanged: true,
      };
    }

    const report = session.operator.addConditions(specs);
    const conditionIds = specs.map((spec) => spec.id);
    for (const id of conditionIds) {
      const condition = [...session.operator.conditions].reverse().find((c) => c.id === id);
      if (condition) session.conditions.set(id, condition);
    }

    const patch = {
      patchId,
      versionId: version.versionId ?? null,
      conditionIds,
      indices,
      span: [indices[0], indices.at(-1) + 1],
      contentHash: sha256Hex(indices).slice(0, 16),
    };
    session.patches.set(patchId, patch);
    const acceptance = {
      acceptedAt: new Date().toISOString(),
      stamp: stampId,
      patchId,
      patch,
      conditionIds,
      conditionId: conditionIds.length === 1 ? conditionIds[0] : null,
      sourceVersion: version.versionId ?? null,
    };
    session.accepted.set(patchId, acceptance);
    for (const id of conditionIds) session.accepted.set(id, acceptance);
    this.events.push({ type: 'accept-version', stamp: stampId, patchId, conditionIds });

    return {
      ok: true,
      accepted: true,
      alreadyEffective: false,
      acceptance,
      patchId,
      patch,
      conditionIds,
      conditionId: acceptance.conditionId,
      report,
    };
  }

  sample(stampId, region, options = {}) {
    if (stampId && typeof stampId === 'object' && !(stampId instanceof CovarianceModel)) {
      const arg = stampId;
      options = { ...arg, ...(region && typeof region === 'object' ? region : {}) };
      region = arg.region ?? arg.range ?? arg.indices ?? arg.pixels;
      stampId = arg.stamp ?? arg.stampId ?? arg.currentStamp;
    } else if (region && typeof region === 'object' && !Array.isArray(region) && !ArrayBuffer.isView(region)) {
      options = { ...region, ...options };
      region = region.region ?? region.range ?? region.indices;
    }
    const session = this.getStamp(stampId, options);
    const result = session.operator.request(region, options);
    const record = this._saveVersion(session, region, result, options);
    return { ...result, versionId: record.versionId, displayedAt: record.displayedAt };
  }

  request(stampId, region, options = {}) {
    return this.sample(stampId, region, options);
  }

  _saveVersion(session, region, result, options) {
    session.seq += 1;
    const displayedAt = new Date().toISOString();
    const versionId =
      options.versionId ??
      `v${session.seq}-` +
        sha256Hex({
          stamp: session.stamp,
          region: canonicalRegion(region),
          seed: result.seed,
          conditions: result.conditionIds,
          values: result.values.map((x) => Number(x.toFixed(12))),
        }).slice(0, 12);
    const record = {
      versionId,
      seq: session.seq,
      stamp: session.stamp,
      region: Array.isArray(region) ? [...region] : region,
      regionKey: canonicalRegion(region),
      indices: [...result.indices],
      values: [...result.values],
      seed: result.seed,
      model: result.model,
      conditionIds: [...result.conditionIds],
      conditionIdentities: result.conditions.map((c) => ({ id: c.id, identity: c.identity })),
      displayedAt,
      source: options.source ?? 'preview',
    };
    session.versions.set(versionId, record);
    session.history.push(record);
    return record;
  }

  history(stampId, regionOrVersionId, options = {}) {
    if (stampId && typeof stampId === 'object' && !Array.isArray(stampId)) {
      const arg = stampId;
      const query = arg.region ?? arg.versionId ?? arg.range ?? arg.indices;
      const stamp = arg.stamp ?? arg.stampId ?? arg.currentStamp;
      if (stamp == null) return this.history(query);
      return this.history(stamp, query, arg);
    }
    if (arguments.length === 1) {
      const query = stampId;
      for (const candidate of this.sessions.values()) {
        if (candidate.versions.has(query)) {
          return { ok: true, ...candidate.versions.get(query) };
        }
      }
      if (typeof query === 'string') {
        for (const session of this.sessions.values()) {
          const key = canonicalRegion(query);
          const found = session.history.find((h) => h.regionKey === key);
          if (found) return { ok: true, ...found };
        }
      }
      throw new MissingInputError(`找不到历史版本: ${String(query)}`, {
        versionId: query,
        code: 'HISTORY_NOT_FOUND',
      });
    }

    const session = this.getStamp(stampId, options);
    if (regionOrVersionId == null) {
      return {
        ok: true,
        stamp: stampId,
        versions: session.history.map((v) =>
          options.includeValues === false ? { ...v, values: undefined } : v,
        ),
      };
    }
    if (typeof regionOrVersionId === 'string' && session.versions.has(regionOrVersionId)) {
      return { ok: true, ...session.versions.get(regionOrVersionId) };
    }
    const key = canonicalRegion(regionOrVersionId);
    for (let i = session.history.length - 1; i >= 0; i -= 1) {
      if (session.history[i].regionKey === key) return { ok: true, ...session.history[i] };
    }
    throw new MissingInputError('找不到对应区域的已展示历史版本', {
      stamp: stampId,
      region: regionOrVersionId,
      regionKey: key,
      code: 'HISTORY_NOT_FOUND',
    });
  }

  readVersion(versionId) {
    return this.history(versionId);
  }

  importLegacyCondition(input, options = {}) {
    const normalized = normalizeCondition(input, {
      data: this.data,
      definitions: this.definitions,
      ...options,
    });
    const knownStamp = normalized.stamp && this.data.stamps?.some((s) => s[0] === normalized.stamp);
    const knownStep =
      normalized.step != null && this.data.stamps?.some((s) => s[1] === normalized.step);
    const stepKnown = Boolean(knownStamp || knownStep);
    const record = {
      condition: normalized,
      stepStatus: stepKnown ? 'known' : 'unknown',
      choices: stepKnown ? undefined : ['rebuild', 'history'],
      options: stepKnown ? undefined : ['rebuild', 'history'],
      actions: stepKnown ? undefined : ['rebuild', 'history'],
      importedAt: new Date().toISOString(),
      history: options.history ?? [],
    };
    this.legacy.set(normalized.id, record);
    if (!stepKnown && options.throwOnUnknown === true) {
      throw new StepResolutionRequiredError(`旧条件 ${normalized.id} 无法确认获取步次`, {
        conditionId: normalized.id,
        choices: ['rebuild', 'history'],
        legacy: record,
      });
    }
    return { ok: true, status: stepKnown ? 'known' : 'step-resolution-required', ...record };
  }

  resolveLegacy(conditionId, choice, options = {}) {
    const record = this.legacy.get(conditionId);
    if (!record) {
      throw new MissingInputError(`找不到旧条件: ${conditionId}`, { conditionId });
    }
    if (choice === 'history') {
      return {
        ok: true,
        choice: 'history',
        conditionId,
        history: record.history,
        choices: ['rebuild', 'history'],
      };
    }
    if (choice !== 'rebuild') {
      throw new MissingInputError('旧条件处理选择必须是 rebuild 或 history', {
        choice,
        choices: ['rebuild', 'history'],
      });
    }
    const stampId = options.stamp ?? options.currentStamp;
    if (!stampId) {
      throw new MissingInputError('重建旧条件需要当前 stamp/step 协方差模型', {
        field: 'stamp',
      });
    }
    const rebuiltInput = {
      ...record.condition,
      id: options.newId ?? `${conditionId}#rebuilt-${stampId}`,
      stamp: stampId,
      step: undefined,
      acquiredAt: new Date().toISOString(),
      rebuiltFrom: conditionId,
    };
    const result = this.condition(stampId, rebuiltInput, {
      allowUnknownStep: true,
      ...options,
    });
    record.resolution = {
      choice: 'rebuild',
      at: new Date().toISOString(),
      newConditionId: result.condition.id,
      stamp: stampId,
    };
    return { ok: true, choice: 'rebuild', ...result };
  }

  runView(view = this.data.view, options = {}) {
    const steps = [];
    for (const call of view) {
      const [op, stamp, argument] = call;
      try {
        let result;
        if (op === 'condition' || op === 'add') result = this.condition(stamp, argument, options);
        else if (op === 'accept') result = this.accept(stamp, argument, options);
        else if (op === 'sample' || op === 'request') result = this.sample(stamp, argument, options);
        else if (op === 'commit') result = this.commit(stamp, argument, options);
        else if (op === 'history') result = this.history(stamp, argument, options);
        else throw new MissingInputError(`未知 view 操作: ${op}`, { op });
        steps.push({ ok: true, call, op, stamp, argument, result });
      } catch (error) {
        const step = {
          ok: false,
          call,
          op,
          stamp,
          argument,
          error: this._errorJSON(error),
        };
        steps.push(step);
        if (options.captureErrors === false) throw error;
      }
    }
    return {
      ok: steps.every((s) => s.ok),
      steps,
      results: steps.map((s) => s.result ?? s.error),
    };
  }

  runCallRecord(view, options) {
    return this.runView(view, options);
  }

  _errorJSON(error) {
    return {
      name: error.name,
      code: error.code,
      codes: error.codes,
      message: error.message,
      conditions: error.conditions,
      conflicts: error.conflicts,
      choices: error.choices,
      fromStamp: error.fromStamp,
      toStamp: error.toStamp,
      missing: error.missing,
    };
  }

  submit(...args) {
    return this.submitFrame(...args);
  }

  addConstraint(...args) {
    return this.condition(...args);
  }

  applyCondition(...args) {
    return this.condition(...args);
  }

  requestRegion(...args) {
    return this.request(...args);
  }

  getHistory(...args) {
    return this.history(...args);
  }

  readHistory(...args) {
    return this.history(...args);
  }

  chooseLegacy(conditionId, choice, options) {
    return this.resolveLegacy(conditionId, choice, options);
  }

  importCondition(input, options) {
    return this.importLegacyCondition(input, options);
  }

  attachLegacyCondition(input, options) {
    return this.importLegacyCondition(input, options);
  }

  resolveOldCondition(conditionId, choice, options) {
    return this.resolveLegacy(conditionId, choice, options);
  }

  session(stampId, options) {
    return this.getStamp(stampId, options);
  }

  budgetStats() {
    return this.native.stats();
  }
}

export function createEditor(options) {
  return new NoiseEditor(options);
}

export const Editor = NoiseEditor;
export const MaskEditor = NoiseEditor;
export const NoiseMaskEditor = NoiseEditor;
export const createMaskEditor = createEditor;
export function createNoiseEditor(options) {
  return createEditor(options);
}

export function runView(view, options = {}) {
  const editor = options.editor ?? createEditor(options);
  return editor.runView(view, options);
}

export const replayView = runView;
export const runCallRecord = runView;
export const runNoiseView = runView;
export const playView = runView;
