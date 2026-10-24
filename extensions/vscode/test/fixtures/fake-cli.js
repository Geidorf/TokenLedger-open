'use strict';

// 测试用的假 tokenledger-cli：按子命令输出 snapshot.json 里对应的一段。
// FAKE_CLI_LOG 指向一个文件时，把每次收到的参数追加进去；FAKE_CLI_FAIL 非空时除 version 外都报错。
const fs = require('node:fs');
const sample = require('./snapshot.json');

const args = process.argv.slice(2);
if (process.env.FAKE_CLI_LOG) fs.appendFileSync(process.env.FAKE_CLI_LOG, `${JSON.stringify(args)}\n`);
if (args[0] === 'version') {
  process.stdout.write('tokenledger-cli 2.0.0\n');
} else if (process.env.FAKE_CLI_FAIL) {
  process.stdout.write(JSON.stringify({ schemaVersion: 1, error: '故意失败' }));
  process.exitCode = 1;
} else if (sample[args[0]]) {
  const value = { ...sample[args[0]] };
  if (args[0] === 'status' && args.includes('--no-quota')) value.quota = null;
  process.stdout.write(JSON.stringify(value));
} else {
  process.stdout.write(JSON.stringify({ schemaVersion: 1, error: `unknown ${args[0]}` }));
  process.exitCode = 1;
}
