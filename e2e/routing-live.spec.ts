import { expect, MOCK_NOW, openPage, test } from './fixtures';

// 路由页顶部的实时路由动画：只画真实记录，失败切换逐跳可见，没有数据源时给空态。
const now = Date.parse(MOCK_NOW);
const ago = (ms: number) => new Date(now - ms).toISOString();

const failover = {
  ts: ago(1_000),
  requestId: 'live-1',
  group: 'coding',
  session: null,
  reason: 'failover',
  detail: '按顺序',
  chosen: 'deepseek/deepseek-chat',
  attempts: [
    { member: 'openai/gpt-5', outcome: 'failed', status: 429 },
    { member: 'deepseek/deepseek-chat', outcome: 'ok', status: 200 },
  ],
};

const ledger = {
  ts: ago(500), requestId: 'att-2', logicalRequestId: 'live-1', agent: 'codex', session: null, endpoint: '/v1/responses', provider: 'deepseek',
  requestedModel: 'group/coding', upstreamModel: 'deepseek-chat', wire: 'chat', stream: true, status: 200, ok: true,
  input: 1, output: 1, cacheRead: 0, cacheWrite: 0, latencyMs: 900, group: 'coding', member: 'deepseek/deepseek-chat',
};

test.describe('实时路由动画', () => {
  // 外部本机网关默认不在运行：各用例只看自带网关，需要外部来源的用例自己覆盖。
  test.beforeEach(async ({ ipc }) => {
    await ipc.override('peer_live_snapshot', { value: { reachable: false, port: 3425, requests: 0, waiting: 0, tools: 0, active: [], recent: [] } });
  });

  test('失败切换：失败成员带状态码，说明写清切到了哪个成员', async ({ page, ipc }) => {
    await ipc.override('gateway_recent_route_decisions', { value: [failover] });
    await ipc.override('gateway_recent_requests', { value: [ledger] });
    await openPage(page, 'routing');
    const stage = page.getByRole('figure', { name: '实时路由动画' });
    await expect(stage).toBeVisible();
    await expect(stage.locator('.rs-agent .rs-node-label')).toHaveText('codex');
    await expect(stage.locator('.rs-agent')).toBeVisible();
    await expect(stage.locator('.rs-tag')).toHaveText('429');
    await expect(stage.locator('.rs-sky .rs-packet')).toHaveCount(3);
    await expect(stage.getByText('codex 的请求（group/coding）：openai/gpt-5 返回 429，已切换到 deepseek/deepseek-chat，已接通')).toBeVisible();
    await expect(page.getByRole('region', { name: '实时路由' }).getByText('已改道')).toBeVisible();
  });

  test('轮询到新的决策时舞台随之更新', async ({ page, ipc }) => {
    await ipc.override('gateway_recent_route_decisions', { value: [] });
    await ipc.override('gateway_recent_requests', { value: [] });
    await openPage(page, 'routing');
    await expect(page.getByText('还没有经过网关的请求')).toBeVisible();
    await ipc.override('gateway_recent_route_decisions', { value: [failover] });
    await expect(page.getByRole('figure', { name: '实时路由动画' }).locator('.rs-tag')).toHaveText('429');
  });

  test('网关没运行时显示空态，不播放任何动画', async ({ page, ipc }) => {
    await ipc.override('gateway_status', { value: { running: false, port: 3462, providerCount: 0, enabledCount: 0 } });
    await openPage(page, 'routing');
    const empty = page.getByRole('region', { name: '实时路由' }).getByRole('status');
    await expect(empty).toContainText('暂无实时路由数据');
    await expect(empty).toContainText('网关未运行');
    await expect(page.locator('.rs-packet')).toHaveCount(0);
  });
  test('外部本机网关：在途请求流动，最近完成的回退逐跳可见', async ({ page, ipc }) => {
    await ipc.override('gateway_status', { value: { running: false, port: 3462, providerCount: 0, enabledCount: 0 } });
    await ipc.override('peer_live_snapshot', { value: {
      reachable: true, port: 3425, requests: 1, waiting: 0, tools: 0,
      active: [{ id: 7, agent: 'claude', model: 'claude-opus-5-5', provider: 'anthropic', started: ago(1_200), ms: 1_200, phase: 'upstream' }],
      recent: [{ id: '9', agent: 'opencode', model: 'glm-4.6', ended: ago(2_000), attempts: [
        { provider: 'relay', outcome: 'failed', status: 529 },
        { provider: 'zhipu', outcome: 'ok' },
      ] }],
    } });
    await openPage(page, 'routing');
    const stage = page.getByRole('figure', { name: '实时路由动画' });
    await expect(stage).toBeVisible();
    await expect(stage.locator('.rs-agent .rs-node-label')).toHaveText(['claude', 'opencode']);
    await expect(stage.locator('.rs-tag')).toHaveText('529');
    await expect(stage.locator('.rs-hub.is-busy')).toHaveCount(1);
    await expect(page.getByRole('region', { name: '实时路由' }).getByText('在途')).toBeVisible();
  });
});
