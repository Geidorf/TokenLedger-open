import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_TRACKED_PATH_LENGTH,
  REPOSITORY_NAME,
  evaluateTrackedPaths,
  runnerPrefixLength,
  trackedFiles,
} from './check-path-length.mjs';

test('预算来自 Windows MAX_PATH 减去 runner 工作区前缀，而不是拍脑袋的整数', () => {
  assert.equal(runnerPrefixLength('TokenLedger'), 'D:\\a\\TokenLedger\\TokenLedger\\'.length);
  assert.equal(runnerPrefixLength('TokenLedger'), 29);
  assert.equal(MAX_TRACKED_PATH_LENGTH, 259 - runnerPrefixLength(REPOSITORY_NAME));
  assert.equal(MAX_TRACKED_PATH_LENGTH, 230);
});

test('超预算且未登记豁免的路径必须报出来', () => {
  const long = `a/${'b'.repeat(240)}.png`;
  const result = evaluateTrackedPaths(['short.txt', long], 230, []);
  assert.equal(result.violations.length, 1);
  assert.equal(result.violations[0].file, long);
  assert.equal(result.violations[0].length, long.length);
});

test('已登记豁免的路径不报违规', () => {
  const long = `a/${'b'.repeat(240)}.png`;
  const result = evaluateTrackedPaths(['short.txt', long], 230, [
    { path: long, owner: 'T10.77', reason: '测试夹具' },
  ]);
  assert.deepEqual(result.violations, []);
  assert.deepEqual(result.staleExemptions, []);
});

test('豁免项一旦被删除或已收敛，门禁自己失败，避免白名单腐烂', () => {
  const removed = evaluateTrackedPaths(['short.txt'], 230, [
    { path: 'gone.png', owner: 'T10.77', reason: '测试夹具' },
  ]);
  assert.equal(removed.staleExemptions.length, 1);
  assert.match(removed.staleExemptions[0].why, /已不在仓库中/u);

  const shrunk = evaluateTrackedPaths(['now-short.png'], 230, [
    { path: 'now-short.png', owner: 'T10.77', reason: '测试夹具' },
  ]);
  assert.equal(shrunk.staleExemptions.length, 1);
  assert.match(shrunk.staleExemptions[0].why, /已收敛到/u);
});

test('真实仓库当前只允许存在已登记的超限路径', () => {
  const result = evaluateTrackedPaths(trackedFiles());
  assert.deepEqual(
    result.violations.map((v) => v.file),
    [],
    '出现了新的超长跟踪路径；请缩短文件名，不要直接加豁免',
  );
  assert.deepEqual(result.staleExemptions, []);
});
