'use strict';

// 打包脚本：产物是 VS Code 认的 .vsix（zip + vsixmanifest），同样输入逐字节相同。
const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const zlib = require('node:zlib');

const scriptUrl = require('node:url').pathToFileURL(path.join(__dirname, '..', 'scripts', 'package-vsix.mjs')).href;

/** 按中央目录读出 zip 里的文件，校验 CRC。 */
function readZip(buffer, crc32) {
  const end = buffer.length - 22;
  assert.equal(buffer.readUInt32LE(end), 0x06054b50);
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  const files = new Map();
  for (let index = 0; index < count; index += 1) {
    assert.equal(buffer.readUInt32LE(offset), 0x02014b50);
    const crc = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const dataStart = localOffset + 30 + localNameLength + buffer.readUInt16LE(localOffset + 28);
    const data = zlib.inflateRawSync(buffer.subarray(dataStart, dataStart + compressedSize));
    assert.equal(crc32(data), crc, `${name} 的 CRC`);
    files.set(name, data);
    offset += 46 + nameLength;
  }
  return files;
}

test('crc32 与标准值一致', async () => {
  const { crc32 } = await import(scriptUrl);
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.equal(crc32(Buffer.alloc(0)), 0);
});

test('vsix 含清单、内容类型、入口与全部源码，可复现', async () => {
  const { buildVsix, crc32 } = await import(scriptUrl);
  const first = buildVsix();
  const second = buildVsix();
  assert.ok(first.buffer.equals(second.buffer), '两次打包逐字节相同');

  const files = readZip(first.buffer, crc32);
  const names = [...files.keys()];
  assert.equal(names[0], 'extension.vsixmanifest');
  assert.ok(names.includes('[Content_Types].xml'));
  for (const name of ['extension/package.json', 'extension/README.md', 'extension/LICENSE.txt', 'extension/media/icon.png',
    'extension/src/extension.js', 'extension/src/cli.js', 'extension/src/view.js', 'extension/src/format.js']) {
    assert.ok(names.includes(name), name);
  }
  // 测试与打包脚本不进包。
  assert.ok(!names.some((name) => name.includes('/test/') || name.includes('/scripts/')));

  const manifest = JSON.parse(files.get('extension/package.json').toString('utf8'));
  const xml = files.get('extension.vsixmanifest').toString('utf8');
  assert.match(xml, new RegExp(`<Identity Language="en-US" Id="${manifest.name}" Version="${manifest.version}" Publisher="${manifest.publisher}" />`));
  assert.match(xml, new RegExp(`Microsoft.VisualStudio.Code.Engine" Value="\\${manifest.engines.vscode}"`));
  assert.match(xml, /ExtensionKind" Value="ui,workspace"/);
  const types = files.get('[Content_Types].xml').toString('utf8');
  for (const ext of ['.js', '.json', '.md', '.png', '.txt', '.vsixmanifest']) assert.ok(types.includes(`Extension="${ext}"`), ext);
  assert.equal(files.get('extension/media/icon.png').subarray(1, 4).toString('latin1'), 'PNG');
});

test('包里的插件清单：命令、设置与激活时机', async () => {
  const manifest = require('../package.json');
  assert.equal(manifest.main, './src/extension.js');
  assert.deepEqual(manifest.activationEvents, ['onStartupFinished']);
  assert.deepEqual(manifest.contributes.commands.map((command) => command.command).sort(),
    ['tokenledger.openSettings', 'tokenledger.refresh', 'tokenledger.showDetails']);
  const properties = manifest.contributes.configuration.properties;
  assert.deepEqual(Object.keys(properties).sort(), [
    'tokenledger.cliPath', 'tokenledger.dataDirectory', 'tokenledger.quota.enabled',
    'tokenledger.refreshIntervalSeconds', 'tokenledger.statusBar.metric',
  ]);
  // 能指定可执行文件的设置不允许工作区覆盖（不受信任的仓库不能让插件去跑别的程序）。
  assert.equal(properties['tokenledger.cliPath'].scope, 'machine');
  assert.equal(properties['tokenledger.dataDirectory'].scope, 'machine');
  // 运行时不依赖任何包。
  assert.equal(manifest.dependencies, undefined);
  assert.equal(manifest.devDependencies, undefined);
});
