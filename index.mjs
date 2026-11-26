import * as api from './src/index.mjs';

export * from './src/index.mjs';

function conditionalNoise(...args) {
  return api.conditionAndSample(...args);
}

Object.assign(conditionalNoise, api);
conditionalNoise.default = conditionalNoise;

export default conditionalNoise;
