#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { createEditor, sampleConditional, loadNoiseKeyData } from './index.mjs';

const [command, ...args] = process.argv.slice(2);

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

if (command === 'view' || command === 'demo' || command === undefined) {
  const editor = createEditor();
  const run = editor.runView(loadNoiseKeyData().view);
  console.log(JSON.stringify({
    ok: run.ok,
    steps: run.steps.map((step) => ({
      op: step.op,
      stamp: step.stamp,
      ok: step.ok,
      code: step.error?.code,
      versionId: step.result?.versionId,
      maxResidual: step.result?.maxResidual,
      latentFetch: step.result?.latentFetch,
    })),
    budget: editor.budgetStats(),
  }, null, 2));
  process.exitCode = run.ok ? 0 : 1;
} else if (command === 'solve') {
  const requestPath = args[0];
  if (!requestPath) {
    console.error('用法: node cli.mjs solve <request.json>');
    process.exit(2);
  }
  const request = readJson(requestPath);
  const result = sampleConditional(request);
  console.log(JSON.stringify(result, (_key, value) => (value instanceof Float64Array ? Array.from(value) : value), 2));
} else {
  console.error(`未知命令: ${command}; 支持 view | solve <request.json>`);
  process.exit(2);
}
