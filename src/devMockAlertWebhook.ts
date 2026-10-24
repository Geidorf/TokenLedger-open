/**
 * 浏览器预览与 E2E 用的 Webhook 推送设置（`src-tauri/src/alert_webhook`）。和真实后端一样：
 * 地址与密钥只进「钥匙串」（这里是内存），读回来只有域名和是否已签名。
 */
interface MockEndpoint {
  id: string;
  platform: string;
  name: string;
  enabled: boolean;
  kinds: string[];
  includeCost: boolean;
  urlHint: string;
  hasSecret: boolean;
  lastResult: { at: string; ok: boolean; error?: string; test: boolean } | null;
}

const SIGNED = new Set(['feishu', 'dingtalk', 'generic']);
let enabled = false;
let endpoints: MockEndpoint[] = [];
const credentials = new Map<string, { url: string; secret?: string }>();
let nextId = 1;

function view() {
  return {
    enabled,
    endpoints,
    sources: { budget: true, quota: false, anomaly: false, periodReport: null },
    maxEndpoints: 8,
  };
}

function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

export function resetMockAlertWebhooks() {
  enabled = false;
  endpoints = [];
  credentials.clear();
  nextId = 1;
}

export function mockAlertWebhookCommand(cmd: string, payload: Record<string, unknown>): { handled: boolean; value?: unknown } {
  switch (cmd) {
    case 'get_alert_webhooks':
      return { handled: true, value: view() };
    case 'set_alert_webhooks_enabled':
      enabled = payload.enabled === true;
      return { handled: true, value: view() };
    case 'save_alert_webhook': {
      const input = (payload.input ?? {}) as Record<string, unknown>;
      const id = typeof input.id === 'string' ? input.id : `wh-mock${nextId++}`;
      const platform = String(input.platform ?? 'generic');
      const previous = credentials.get(id);
      const url = typeof input.url === 'string' && input.url ? input.url : previous?.url;
      if (!url) throw new Error('请填写 Webhook 地址。');
      if (!/^https:\/\//.test(url)) throw new Error('Webhook 必须使用 HTTPS；只有本机地址可以用 HTTP。');
      const secret = !SIGNED.has(platform) || input.clearSecret === true
        ? undefined
        : typeof input.secret === 'string' && input.secret ? input.secret : previous?.secret;
      credentials.set(id, { url, secret });
      const endpoint: MockEndpoint = {
        id,
        platform,
        name: typeof input.name === 'string' && input.name.trim() ? input.name.trim() : platform,
        enabled: input.enabled !== false,
        kinds: Array.isArray(input.kinds) ? input.kinds.map(String) : [],
        includeCost: input.includeCost === true,
        urlHint: host(url),
        hasSecret: Boolean(secret),
        lastResult: endpoints.find((item) => item.id === id)?.lastResult ?? null,
      };
      endpoints = endpoints.some((item) => item.id === id)
        ? endpoints.map((item) => (item.id === id ? endpoint : item))
        : [...endpoints, endpoint];
      return { handled: true, value: view() };
    }
    case 'delete_alert_webhook':
      endpoints = endpoints.filter((item) => item.id !== payload.id);
      credentials.delete(String(payload.id));
      return { handled: true, value: view() };
    case 'test_alert_webhook': {
      const ok = !String(credentials.get(String(payload.id))?.url ?? '').includes('fail');
      const result = ok
        ? { ok: true, error: null }
        : { ok: false, error: 'HTTP 404，机器人可能已被删除' };
      endpoints = endpoints.map((item) => (item.id === payload.id
        ? { ...item, lastResult: { at: new Date().toISOString(), ok, error: result.error ?? undefined, test: true } }
        : item));
      return { handled: true, value: result };
    }
    default:
      return { handled: false };
  }
}
