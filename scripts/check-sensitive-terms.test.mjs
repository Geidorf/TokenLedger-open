import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { TERM_DIGESTS, containsSensitiveTerm } from './check-sensitive-terms.mjs';

// 名单本身不能以明文出现在仓库里，所以用一个无关的替身词验证匹配规则。
const word = 'zebrafish';
const digests = new Set([createHash('sha256').update(word).digest('hex')]);
const lengths = [word.length];
const hit = (text) => containsSensitiveTerm(text, digests, lengths);

test('the term list holds only lowercase sha256 digests', () => {
  assert.ok(TERM_DIGESTS.length > 0);
  for (const term of TERM_DIGESTS) {
    assert.match(term.sha256, /^[0-9a-f]{64}$/u);
    assert.ok(Number.isInteger(term.length) && term.length > 0);
  }
});

test('matches the term however it is joined or cased', () => {
  for (const text of [
    'zebrafish',
    'ZebraFish import',
    'ZebrafishImportCard.tsx',
    'commands::zebrafish_import',
    'docs/contracts/zebrafish-sync-v1.md',
    '从zebrafish导入',
    'ZEBRAFISH',
  ]) {
    assert.equal(hit(text), true, text);
  }
});

test('leaves unrelated text alone', () => {
  for (const text of ['zebra fish', 'zebrafis', '斑马鱼', '', undefined]) {
    assert.equal(hit(text), false, String(text));
  }
});
