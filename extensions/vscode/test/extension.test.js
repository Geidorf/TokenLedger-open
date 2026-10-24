'use strict';

// 用一个最小的 vscode 替身加载插件入口，配上假的命令行，走一遍激活、刷新、详情与设置变化。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

function createVscodeStub(settings) {
  const commands = new Map();
  const listeners = { config: [], window: [] };
  const created = { items: [], panels: [] };
  const disposable = { dispose() {} };
  class MarkdownString {
    constructor(value, supportThemeIcons) {
      this.value = value;
      this.supportThemeIcons = supportThemeIcons;
    }
  }
  class ThemeColor {
    constructor(id) {
      this.id = id;
    }
  }
  const vscode = {
    MarkdownString,
    ThemeColor,
    StatusBarAlignment: { Left: 1, Right: 2 },
    ViewColumn: { Active: -1 },
    commands: {
      registerCommand(id, handler) {
        commands.set(id, handler);
        return disposable;
      },
      executeCommand: async () => {},
    },
    workspace: {
      getConfiguration: () => ({ get: (key, fallback) => (key in settings ? settings[key] : fallback) }),
      onDidChangeConfiguration(listener) {
        listeners.config.push(listener);
        return disposable;
      },
    },
    window: {
      state: { focused: true },
      createStatusBarItem(id, alignment, priority) {
        const item = { id, alignment, priority, shown: false, show() { this.shown = true; }, dispose() {} };
        created.items.push(item);
        return item;
      },
      createWebviewPanel(viewType, title) {
        const panel = {
          viewType,
          title,
          webview: { cspSource: 'vscode-webview:', html: '', onDidReceiveMessage: () => disposable },
          onDidDispose: () => disposable,
          reveal() {},
        };
        created.panels.push(panel);
        return panel;
      },
      onDidChangeWindowState(listener) {
        listeners.window.push(listener);
        return disposable;
      },
    },
  };
  return { vscode, commands, listeners, created };
}

function loadExtension(stub) {
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === 'vscode') return stub.vscode;
    return originalLoad.call(this, request, parent, isMain);
  };
  const entry = require.resolve('../src/extension.js');
  delete require.cache[entry];
  try {
    return require(entry);
  } finally {
    Module._load = originalLoad;
  }
}

function makeFakeCli(dir) {
  const script = path.join(dir, 'tokenledger-cli');
  const target = path.join(__dirname, 'fixtures', 'fake-cli.js');
  fs.writeFileSync(script, `#!/bin/sh\nexec "${process.execPath}" "${target}" "$@"\n`, { mode: 0o755 });
  return script;
}

const skip = process.platform === 'win32' ? '假命令行用 sh 脚本，Windows 上跳过' : false;

test('激活后状态栏显示今日费用，悬停与详情都有内容；关额度后带 --no-quota', { skip }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenledger-vscode-'));
  const log = path.join(dir, 'calls.log');
  process.env.FAKE_CLI_LOG = log;
  const settings = { cliPath: makeFakeCli(dir), 'statusBar.metric': 'cost', 'quota.enabled': true };
  const stub = createVscodeStub(settings);
  const extension = loadExtension(stub);
  const context = { subscriptions: [] };
  const controller = extension.activate(context);
  try {
    await controller.refreshing;
    const item = stub.created.items[0];
    assert.equal(item.shown, true);
    assert.equal(item.command, 'tokenledger.showDetails');
    assert.equal(item.text, '$(graph) ≈$2.56');
    assert.equal(item.backgroundColor.id, 'statusBarItem.warningBackground');
    assert.match(item.tooltip.value, /\*\*额度\*\*/);
    assert.match(item.tooltip.value, /Claude 5 hour window/);
    assert.deepEqual(item.tooltip.isTrusted.enabledCommands.sort(), ['tokenledger.openSettings', 'tokenledger.refresh', 'tokenledger.showDetails']);

    const calls = () => fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.ok(calls().some((args) => args[0] === 'quota'), '首轮取额度列表');

    // 普通刷新 5 分钟内不再取额度列表，但保留上一轮的。
    fs.writeFileSync(log, '');
    await controller.refresh();
    assert.ok(!calls().some((args) => args[0] === 'quota'));
    assert.match(item.tooltip.value, /Claude 5 hour window/);

    // 单击：打开详情面板并强制刷新。
    await stub.commands.get('tokenledger.showDetails')();
    await controller.refreshing;
    const panel = stub.created.panels[0];
    assert.match(panel.webview.html, /TokenLedger · 今日/);
    assert.match(panel.webview.html, /可用 14%/);

    // 关掉额度：状态摘要带 --no-quota，也不再取额度列表。
    fs.writeFileSync(log, '');
    settings['quota.enabled'] = false;
    stub.listeners.config[0]({ affectsConfiguration: (section) => section === 'tokenledger' });
    await controller.refreshing;
    const statusCall = calls().find((args) => args[0] === 'status');
    assert.deepEqual(statusCall, ['status', '--no-quota', '--json']);
    assert.ok(!calls().some((args) => args[0] === 'quota'));
    assert.match(item.tooltip.value, /已在设置里关闭额度读取/);

    // 命令行路径失效：提示找不到并给出设置入口。
    settings.cliPath = path.join(dir, 'missing-cli');
    stub.listeners.config[0]({ affectsConfiguration: () => true });
    await controller.refreshing;
    assert.equal(item.text, '$(warning) TokenLedger');
    assert.match(item.tooltip.value, /找不到 `tokenledger-cli`/);
  } finally {
    controller.dispose();
    delete process.env.FAKE_CLI_LOG;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
