'use strict';

// VS Code 入口：状态栏一项，悬停看额度条、今日拆分、预算与网关，单击打开详情面板。
// 数据只来自本机 tokenledger-cli（docs/cli.md），插件本身不读账本与密钥、不发网络请求。

const crypto = require('node:crypto');
const vscode = require('vscode');
const { CliNotFoundError, cliCandidates, fetchSnapshot, locateCli, runJson } = require('./cli');
const { detailsHtml, statusBarModel, tooltipMarkdown } = require('./view');

const MIN_INTERVAL_SECONDS = 15;
// 额度要逐个查已授权的来源，比读账本慢；额度列表最多每 5 分钟取一次，手动刷新时总会取。
const QUOTA_LIST_MIN_MS = 5 * 60_000;

// 查额度的命令要等各来源的有界探测走完（桌面端的增强来源最长约 44 秒），给 60 秒；其余 20 秒。
const QUOTA_TIMEOUT_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 20_000;

function timeoutFor(args) {
  const queriesQuota = args[0] === 'quota' || (args[0] === 'status' && !args.includes('--no-quota'));
  return queriesQuota ? QUOTA_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
}

function readConfig() {
  const config = vscode.workspace.getConfiguration('tokenledger');
  return {
    cliPath: config.get('cliPath', ''),
    dataDirectory: config.get('dataDirectory', ''),
    metric: config.get('statusBar.metric', 'cost'),
    intervalSeconds: Math.max(MIN_INTERVAL_SECONDS, Number(config.get('refreshIntervalSeconds', 60)) || 60),
    quotaEnabled: config.get('quota.enabled', true) !== false,
  };
}

class Controller {
  constructor(context) {
    this.context = context;
    this.config = readConfig();
    this.state = { snapshot: null, updatedAt: null, lastError: null, notFound: false };
    this.cliPath = null;
    this.refreshing = null;
    this.timer = null;
    this.quotaFetchedAt = 0;
    this.panel = null;
    // 设置每变一次加一；刷新途中设置变了，这一轮的结果作废并在结束后按新设置再刷一次。
    this.configGeneration = 0;
    this.rerun = false;

    this.item = vscode.window.createStatusBarItem('tokenledger.status', vscode.StatusBarAlignment.Right, 100);
    this.item.name = 'TokenLedger';
    this.item.command = 'tokenledger.showDetails';
    this.item.text = '$(sync~spin) TokenLedger';
    this.item.show();
    context.subscriptions.push(this.item);
  }

  env() {
    const env = { ...process.env };
    const dir = typeof this.config.dataDirectory === 'string' ? this.config.dataDirectory.trim() : '';
    if (dir) env.TOKENLEDGER_APPDATA = dir;
    return env;
  }

  async ensureCli() {
    if (this.cliPath) return this.cliPath;
    const generation = this.configGeneration;
    const found = await locateCli(cliCandidates(this.config.cliPath), { env: this.env() });
    // 找的途中设置变了：不记下按旧设置找到的路径。
    if (generation === this.configGeneration) this.cliPath = found;
    return found;
  }

  refresh({ force = false } = {}) {
    if (this.refreshing) {
      if (force) this.rerun = true;
      return this.refreshing;
    }
    this.refreshing = this.doRefresh(force).then(() => {
      this.refreshing = null;
      if (this.rerun) {
        this.rerun = false;
        return this.refresh({ force: true });
      }
      return undefined;
    });
    return this.refreshing;
  }

  async doRefresh(force) {
    const generation = this.configGeneration;
    try {
      const cli = await this.ensureCli();
      const now = Date.now();
      const includeQuotaList = this.config.quotaEnabled
        && (force || !this.state.snapshot || !this.state.snapshot.quota || now - this.quotaFetchedAt >= QUOTA_LIST_MIN_MS);
      const env = this.env();
      const snapshot = await fetchSnapshot((args) => runJson(cli, args, { env, timeoutMs: timeoutFor(args) }), {
        quota: this.config.quotaEnabled,
        includeQuotaList,
      });
      if (generation !== this.configGeneration) return;
      // 先看这一轮实际跑的命令是否全失败，再补上沿用的额度列表。
      const failures = Object.values(snapshot).filter((section) => section && section.error);
      const allFailed = failures.length === Object.keys(snapshot).length;
      if (includeQuotaList) this.quotaFetchedAt = now;
      else if (this.config.quotaEnabled && this.state.snapshot) snapshot.quota = this.state.snapshot.quota;

      if (allFailed && this.state.snapshot) {
        // 全部失败：保留上一轮的数字，只标出失败原因。
        this.state = { ...this.state, lastError: failures[0].error, notFound: false };
        // 可能是命令行被卸载或换了位置，下一轮重新找。
        this.cliPath = null;
      } else {
        this.state = {
          snapshot,
          updatedAt: new Date(),
          lastError: snapshot.status && snapshot.status.error ? snapshot.status.error : null,
          notFound: false,
        };
      }
    } catch (error) {
      if (generation !== this.configGeneration) return;
      this.cliPath = null;
      if (error instanceof CliNotFoundError) {
        this.state = { snapshot: null, updatedAt: null, lastError: null, notFound: true };
      } else {
        this.state = { ...this.state, lastError: error instanceof Error ? error.message : String(error) };
      }
    }
    this.render();
  }

  render() {
    const model = statusBarModel(this.state, this.config.metric);
    this.item.text = model.text;
    this.item.accessibilityInformation = { label: model.accessibility, role: 'button' };
    this.item.backgroundColor = model.severity === 'error'
      ? new vscode.ThemeColor('statusBarItem.errorBackground')
      : model.severity === 'warning'
        ? new vscode.ThemeColor('statusBarItem.warningBackground')
        : undefined;
    const tooltip = new vscode.MarkdownString(
      tooltipMarkdown(this.state, { quotaEnabled: this.config.quotaEnabled }),
      true,
    );
    tooltip.isTrusted = { enabledCommands: ['tokenledger.refresh', 'tokenledger.showDetails', 'tokenledger.openSettings'] };
    this.item.tooltip = tooltip;
    this.renderPanel();
  }

  renderPanel() {
    if (!this.panel) return;
    this.panel.webview.html = detailsHtml(this.state, {
      nonce: crypto.randomBytes(16).toString('base64'),
      cspSource: this.panel.webview.cspSource,
      quotaEnabled: this.config.quotaEnabled,
    });
  }

  showDetails() {
    if (this.panel) {
      this.panel.reveal();
    } else {
      this.panel = vscode.window.createWebviewPanel('tokenledger.details', 'TokenLedger', vscode.ViewColumn.Active, {
        enableScripts: true,
        localResourceRoots: [],
      });
      this.panel.onDidDispose(() => {
        this.panel = null;
      }, null, this.context.subscriptions);
      this.panel.webview.onDidReceiveMessage((message) => {
        if (message && message.command === 'refresh') this.refresh({ force: true });
        if (message && message.command === 'openSettings') openSettings();
      }, null, this.context.subscriptions);
      this.renderPanel();
    }
    this.refresh({ force: true });
  }

  schedule() {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      // 窗口不在前台时不刷新，切回来时补一次（见 onDidChangeWindowState）。
      if (vscode.window.state.focused) this.refresh();
    }, this.config.intervalSeconds * 1000);
  }

  onConfigChanged() {
    const previous = this.config;
    this.config = readConfig();
    this.configGeneration += 1;
    if (previous.cliPath !== this.config.cliPath || previous.dataDirectory !== this.config.dataDirectory) {
      this.cliPath = null;
    }
    if (previous.intervalSeconds !== this.config.intervalSeconds) this.schedule();
    this.refresh({ force: true });
  }

  onFocusChanged(focused) {
    if (!focused || !this.state.updatedAt) return;
    if (Date.now() - this.state.updatedAt.getTime() >= this.config.intervalSeconds * 1000) this.refresh();
  }

  dispose() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

function openSettings() {
  return vscode.commands.executeCommand('workbench.action.openSettings', '@ext:tokenledger.tokenledger-status');
}

function activate(context) {
  const controller = new Controller(context);
  context.subscriptions.push(
    controller,
    vscode.commands.registerCommand('tokenledger.refresh', () => controller.refresh({ force: true })),
    vscode.commands.registerCommand('tokenledger.showDetails', () => controller.showDetails()),
    vscode.commands.registerCommand('tokenledger.openSettings', openSettings),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('tokenledger')) controller.onConfigChanged();
    }),
    vscode.window.onDidChangeWindowState((state) => controller.onFocusChanged(state.focused)),
  );
  controller.schedule();
  controller.refresh({ force: true });
  return controller;
}

function deactivate() {}

module.exports = { activate, deactivate, timeoutFor };
