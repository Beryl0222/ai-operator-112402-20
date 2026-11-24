import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import { noiseRow, noiseNormal, conditionTile } from '../inputs/noise-key.mjs';

const data=JSON.parse(readFileSync(new URL('../inputs/noise-key.json',import.meta.url),'utf8'));
test('扩散网格、白噪声身份和条件块的格式与关联', () => {
  const n=data.grid.reduce((a,b)=>a*b);
  assert.ok(n**2*8>data.workBytes*1000);
  assert.ok(data.latentFetch<n/8);
  assert.ok(data.conditions[0][2].every((x,i)=>2*x===data.conditions[1][2][i]));
  assert.notEqual(data.conditions[1][3],data.conditions[2][3]);
  assert.equal(noiseRow(17,'basis1').u.length,data.rank);
  assert.notDeepEqual(noiseRow(17,'basis1').u,noiseRow(17,'basis2').u);
  assert.notEqual(noiseNormal('T18','epsilon',0),noiseNormal('T18','eta',0));
  assert.equal(conditionTile(1).length,data.tileConditions);
  assert.ok(conditionTile(data.maxConditionTiles-1).at(-1)[1].every(i=>i<n));
});
