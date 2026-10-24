import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { t } from '../i18n';

/** Mirrors `src-tauri/src/alert_webhook`. Addresses and secrets never come back from Rust. */
export const WEBHOOK_PLATFORMS = ['feishu', 'dingtalk', 'wecom', 'slack', 'discord', 'generic'] as const;
export type WebhookPlatform = (typeof WEBHOOK_PLATFORMS)[number];

export const ALERT_KINDS = ['budget', 'quota', 'anomaly', 'periodReport'] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

/** Platforms whose robots take an optional signing secret. */
export const SIGNED_PLATFORMS: ReadonlySet<WebhookPlatform> = new Set(['feishu', 'dingtalk', 'generic']);

export interface DeliveryResult {
  at: string;
  ok: boolean;
  error?: string;
  test: boolean;
}

export interface WebhookEndpoint {
  id: string;
  platform: WebhookPlatform;
  name: string;
  enabled: boolean;
  kinds: AlertKind[];
  includeCost: boolean;
  urlHint: string;
  hasSecret: boolean;
  lastResult: DeliveryResult | null;
}

export interface SourceSwitches {
  budget: boolean;
  quota: boolean;
  anomaly: boolean;
  /** `null` while the build has no period report reminder. */
  periodReport: boolean | null;
}

export interface AlertWebhookView {
  enabled: boolean;
  endpoints: WebhookEndpoint[];
  sources: SourceSwitches;
  maxEndpoints: number;
}

export interface EndpointInput {
  id?: string;
  platform: WebhookPlatform;
  name: string;
  enabled: boolean;
  kinds: AlertKind[];
  includeCost: boolean;
  url?: string;
  secret?: string;
  clearSecret?: boolean;
}

export const EMPTY_WEBHOOK_VIEW: AlertWebhookView = {
  enabled: false,
  endpoints: [],
  sources: { budget: false, quota: false, anomaly: false, periodReport: null },
  maxEndpoints: 8,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function parseResult(value: unknown): DeliveryResult | null {
  if (!isRecord(value) || typeof value.at !== 'string' || typeof value.ok !== 'boolean') return null;
  return {
    at: value.at,
    ok: value.ok,
    error: typeof value.error === 'string' ? value.error : undefined,
    test: value.test === true,
  };
}

function parseEndpoint(value: unknown): WebhookEndpoint | null {
  if (!isRecord(value) || typeof value.id !== 'string') return null;
  const platform = WEBHOOK_PLATFORMS.find((item) => item === value.platform);
  if (!platform) return null;
  const kinds = Array.isArray(value.kinds)
    ? ALERT_KINDS.filter((kind) => (value.kinds as unknown[]).includes(kind))
    : [];
  return {
    id: value.id,
    platform,
    name: typeof value.name === 'string' ? value.name : '',
    enabled: value.enabled === true,
    kinds,
    includeCost: value.includeCost === true,
    urlHint: typeof value.urlHint === 'string' ? value.urlHint : '',
    hasSecret: value.hasSecret === true,
    lastResult: parseResult(value.lastResult),
  };
}

export function parseWebhookView(value: unknown): AlertWebhookView {
  if (!isRecord(value)) return EMPTY_WEBHOOK_VIEW;
  const sources = isRecord(value.sources) ? value.sources : {};
  return {
    enabled: value.enabled === true,
    endpoints: Array.isArray(value.endpoints)
      ? value.endpoints.map(parseEndpoint).filter((item): item is WebhookEndpoint => item !== null)
      : [],
    sources: {
      budget: sources.budget === true,
      quota: sources.quota === true,
      anomaly: sources.anomaly === true,
      periodReport: typeof sources.periodReport === 'boolean' ? sources.periodReport : null,
    },
    maxEndpoints: typeof value.maxEndpoints === 'number' ? value.maxEndpoints : EMPTY_WEBHOOK_VIEW.maxEndpoints,
  };
}

const errorText = (error: unknown, fallback: string) =>
  typeof error === 'string' && error.trim() ? error : fallback;

/** Settings budget section, webhook card state. Every write returns the fresh view from Rust. */
export function useAlertWebhooks() {
  const [view, setView] = useState<AlertWebhookView>(EMPTY_WEBHOOK_VIEW);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [testing, setTesting] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    invoke<unknown>('get_alert_webhooks')
      .then((value) => {
        if (active) setView(parseWebhookView(value));
      })
      .catch(() => {
        if (active) setError(t('webhook.error.load'));
      })
      .finally(() => {
        if (active) setLoaded(true);
      });
    return () => {
      active = false;
    };
  }, []);

  const run = useCallback(async (command: string, args: Record<string, unknown>, fallback: string) => {
    setBusy(true);
    setError('');
    try {
      setView(parseWebhookView(await invoke<unknown>(command, args)));
      return true;
    } catch (caught) {
      setError(errorText(caught, fallback));
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  const setEnabled = useCallback(
    (enabled: boolean) => run('set_alert_webhooks_enabled', { enabled }, t('webhook.error.save')),
    [run],
  );
  const save = useCallback(
    (input: EndpointInput) => run('save_alert_webhook', { input }, t('webhook.error.save')),
    [run],
  );
  const remove = useCallback(
    (id: string) => run('delete_alert_webhook', { id }, t('webhook.error.delete')),
    [run],
  );

  const test = useCallback(async (id: string): Promise<{ ok: boolean; error?: string }> => {
    setTesting(id);
    try {
      const value = await invoke<unknown>('test_alert_webhook', { id });
      const result = isRecord(value) && typeof value.ok === 'boolean'
        ? { ok: value.ok, error: typeof value.error === 'string' ? value.error : undefined }
        : { ok: false, error: t('webhook.error.test') };
      // The test result is also stored as the endpoint's last delivery.
      invoke<unknown>('get_alert_webhooks').then((next) => setView(parseWebhookView(next))).catch(() => {});
      return result;
    } catch (caught) {
      return { ok: false, error: errorText(caught, t('webhook.error.test')) };
    } finally {
      setTesting(null);
    }
  }, []);

  return { view, loaded, busy, error, testing, setEnabled, save, remove, test };
}
