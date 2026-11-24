import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const d = JSON.parse(readFileSync(new URL('../inputs/session.json', import.meta.url), 'utf8'));

test("两种物理排列覆盖有效槽位", () => {
  assert.ok(d.packs.every(p=>new Set(p.order).size===d.lanes.length));
});

test("两步耦合依赖不同分组", () => {
  assert.ok(d.coupling.even.every(([a,b,,z])=>a%2===0&&b%2===1&&z>0)&&d.coupling.odd.every(([a,b,,z])=>a%2&&b%2===0&&z>0));
});

test("同一修订的依赖跨两片到达", () => {
  assert.ok(d.tiles[1].rev===d.tiles[2].rev&&d.tiles[1].lanes.length<d.tiles[0].lanes.length);
});
