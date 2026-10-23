import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { TERM_DIGESTS, containsSensitiveTerm, diffRange, patchPath, redact } from './check-sensitive-terms.mjs';

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

test('diffs from the merge base, so a branch behind main is not blamed for main', () => {
  assert.equal(diffRange('origin/main..abc123'), 'origin/main...abc123');
  assert.equal(diffRange('origin/main...abc123'), 'origin/main...abc123');
});

test('reads the new path from a patch header, quoted or not', () => {
  assert.equal(patchPath('b/docs/a.md'), 'docs/a.md');
  assert.equal(patchPath('b/文档/说明.md'), '文档/说明.md');
  assert.equal(patchPath('"b/docs/a\\tb.md"'), 'docs/a\\tb.md');
  assert.equal(patchPath('/dev/null'), null);
});

test('redacts the term out of reported paths', () => {
  assert.equal(
    redact('src/ZebrafishImportCard.tsx:12', digests, lengths),
    'src/***.tsx:12',
  );
  assert.equal(redact('docs/plain.md:3', digests, lengths), 'docs/plain.md:3');
});
