'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  CliError,
  CliNotFoundError,
  cliCandidates,
  fetchSnapshot,
  locateCli,
  runJson,
  snapshotCommands,
} = require('../src/cli');

// 假的 execFile：按参数返回预设的 (error, stdout, stderr)。
function fakeExecFile(handler) {
  const calls = [];
  const execFile = (file, args, options, callback) => {
    calls.push({ file, args, options });
    const [error, stdout, stderr] = handler(file, args);
    setImmediate(() => callback(error, stdout, stderr || ''));
  };
  execFile.calls = calls;
  return execFile;
}

test('设置里写了路径就只用它，否则按 PATH 与安装位置找', () => {
  assert.deepEqual(cliCandidates('  /opt/tl/tokenledger-cli '), ['/opt/tl/tokenledger-cli']);
  const linux = cliCandidates('', 'linux', { HOME: '/home/u' });
  assert.equal(linux[0], 'tokenledger-cli');
  assert.ok(linux.includes('/usr/bin/tokenledger-cli'));
  assert.ok(linux.includes('/home/u/.local/bin/tokenledger-cli'));
  const mac = cliCandidates('', 'darwin', { HOME: '/Users/u' });
  assert.ok(mac.includes('/Applications/TokenLedger.app/Contents/MacOS/tokenledger-cli'));
  assert.ok(mac.includes('/Users/u/Applications/TokenLedger.app/Contents/MacOS/tokenledger-cli'));
  const win = cliCandidates('', 'win32', { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', ProgramFiles: 'C:\\Program Files' });
  assert.equal(win[0], 'tokenledger-cli.exe');
  assert.ok(win.includes('C:\\Users\\u\\AppData\\Local\\tokenledger\\tokenledger-cli.exe'));
  assert.ok(win.includes('C:\\Program Files\\tokenledger\\tokenledger-cli.exe'));
});

test('locateCli 跳过不存在的绝对路径与跑不起来的名字', async () => {
  const execFile = fakeExecFile((file) => (file === '/b/tokenledger-cli'
    ? [null, 'tokenledger-cli 2.0.0\n']
    : [Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }), '']));
  const found = await locateCli(['tokenledger-cli', '/a/tokenledger-cli', '/b/tokenledger-cli'], {
    execFile,
    exists: (file) => file !== '/a/tokenledger-cli',
  });
  assert.equal(found, '/b/tokenledger-cli');
  assert.deepEqual(execFile.calls.map((call) => call.file), ['tokenledger-cli', '/b/tokenledger-cli']);
  assert.deepEqual(execFile.calls[1].args, ['version']);
});

test('locateCli 都找不到时抛 CliNotFoundError', async () => {
  const execFile = fakeExecFile(() => [Object.assign(new Error('ENOENT'), { code: 'ENOENT' }), '']);
  await assert.rejects(locateCli(['tokenledger-cli'], { execFile }), CliNotFoundError);
});

test('runJson 解析输出，失败时取命令行给的说明', async () => {
  const ok = fakeExecFile(() => [null, '{"schemaVersion":1,"command":"status"}']);
  assert.deepEqual(await runJson('cli', ['status', '--json'], { execFile: ok }), { schemaVersion: 1, command: 'status' });
  assert.equal(ok.calls[0].options.windowsHide, true);

  const failed = fakeExecFile(() => [Object.assign(new Error('exit 1'), { code: 1 }), '{"schemaVersion":1,"error":"账本打不开"}\n', 'tokenledger-cli: 账本打不开']);
  await assert.rejects(runJson('cli', ['status', '--json'], { execFile: failed }), (error) => error instanceof CliError && error.message === '账本打不开');

  const timeout = fakeExecFile(() => [Object.assign(new Error('killed'), { killed: true, signal: 'SIGTERM' }), '']);
  await assert.rejects(runJson('cli', ['quota', '--json'], { execFile: timeout, timeoutMs: 20_000 }), /超过 20 秒/);

  const newer = fakeExecFile(() => [null, '{"schemaVersion":2}']);
  await assert.rejects(runJson('cli', ['status', '--json'], { execFile: newer }), /schemaVersion 2/);

  const garbage = fakeExecFile(() => [null, 'not json']);
  await assert.rejects(runJson('cli', ['status', '--json'], { execFile: garbage }), /不是 JSON/);
});

test('关闭额度时状态摘要带 --no-quota，也不取额度列表', () => {
  const off = snapshotCommands({ quota: false, includeQuotaList: true });
  assert.deepEqual(off.status, ['status', '--no-quota', '--json']);
  assert.equal(off.quota, undefined);
  const on = snapshotCommands({ quota: true, includeQuotaList: true });
  assert.deepEqual(on.status, ['status', '--json']);
  assert.deepEqual(on.quota, ['quota', '--json']);
  assert.deepEqual(on.gateway, ['gateway', '--limit', '20', '--json']);
  assert.deepEqual(on.usage, ['usage', 'today', '--by', 'agent', '--json']);
  assert.equal(snapshotCommands({ quota: true, includeQuotaList: false }).quota, undefined);
});

test('fetchSnapshot 每项单独成败', async () => {
  const snapshot = await fetchSnapshot(async (args) => {
    if (args[0] === 'gateway') throw new CliError('网关配置读不了');
    return { schemaVersion: 1, command: args[0] };
  }, { quota: true, includeQuotaList: true });
  assert.equal(snapshot.status.value.command, 'status');
  assert.equal(snapshot.quota.value.command, 'quota');
  assert.equal(snapshot.gateway.error, '网关配置读不了');
});

// 有真实命令行时（TOKENLEDGER_CLI 指向它）跑一轮，确认插件用到的字段都在。
test('真实命令行的输出带着插件要用的字段', { skip: process.env.TOKENLEDGER_CLI ? false : '没有设置 TOKENLEDGER_CLI' }, async () => {
  const cli = process.env.TOKENLEDGER_CLI;
  const snapshot = await fetchSnapshot((args) => runJson(cli, args, { env: process.env, timeoutMs: 60_000 }), { quota: true, includeQuotaList: true });
  for (const [key, section] of Object.entries(snapshot)) assert.equal(section.error, undefined, `${key}: ${section.error}`);
  assert.ok('totalCost' in snapshot.status.value.today && 'quota' in snapshot.status.value && 'budget' in snapshot.status.value);
  assert.equal(snapshot.usage.value.breakdown.by, 'agent');
  assert.ok(Array.isArray(snapshot.budget.value.statuses));
  assert.equal(typeof snapshot.gateway.value.running, 'boolean');
  assert.ok(Array.isArray(snapshot.quota.value.providers));
});
