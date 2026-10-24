import { useState } from 'react';
import { Pencil, Send, Trash2, Webhook } from 'lucide-react';
import {
  ALERT_KINDS,
  SIGNED_PLATFORMS,
  WEBHOOK_PLATFORMS,
  useAlertWebhooks,
  type AlertKind,
  type AlertWebhookView,
  type DeliveryResult,
  type WebhookEndpoint,
  type WebhookPlatform,
} from '../../hooks/useAlertWebhooks';
import { localized, useLang, useT, type Lang } from '../../i18n';
import { SettingsActionRow, SettingsCard, SettingsGroup, SettingsRow, SettingsToggleRow } from './SettingsPrimitives';
import '../../styles/alertWebhook.css';

const PLATFORM_LABELS = localized<WebhookPlatform>({
  feishu: 'webhook.platform.feishu',
  dingtalk: 'webhook.platform.dingtalk',
  wecom: 'webhook.platform.wecom',
  slack: 'webhook.platform.slack',
  discord: 'webhook.platform.discord',
  generic: 'webhook.platform.generic',
});

const URL_PLACEHOLDERS = localized<WebhookPlatform>({
  feishu: 'webhook.url.placeholder.feishu',
  dingtalk: 'webhook.url.placeholder.dingtalk',
  wecom: 'webhook.url.placeholder.wecom',
  slack: 'webhook.url.placeholder.slack',
  discord: 'webhook.url.placeholder.discord',
  generic: 'webhook.url.placeholder.generic',
});

export const KIND_LABELS = localized<AlertKind>({
  budget: 'webhook.kind.budget',
  quota: 'webhook.kind.quota',
  anomaly: 'webhook.kind.anomaly',
  periodReport: 'webhook.kind.periodReport',
});

interface Draft {
  id: string | null;
  platform: WebhookPlatform;
  name: string;
  url: string;
  secret: string;
  clearSecret: boolean;
  kinds: AlertKind[];
  includeCost: boolean;
  enabled: boolean;
}

const EMPTY_DRAFT: Draft = {
  id: null,
  platform: 'feishu',
  name: '',
  url: '',
  secret: '',
  clearSecret: false,
  kinds: [...ALERT_KINDS],
  includeCost: false,
  enabled: true,
};

function time(at: string, lang: Lang): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** The row hint: platform, host, signing, kinds, last delivery. */
export function endpointSummary(endpoint: WebhookEndpoint, translate: ReturnType<typeof useT>, lang: Lang): string {
  const parts = [PLATFORM_LABELS[endpoint.platform]];
  if (endpoint.urlHint) parts.push(endpoint.urlHint);
  if (endpoint.hasSecret) parts.push(translate('webhook.row.signed'));
  parts.push(endpoint.kinds.length
    ? translate('webhook.row.kinds', { kinds: endpoint.kinds.map((kind) => KIND_LABELS[kind]).join(translate('webhook.row.separator')) })
    : translate('webhook.row.noKinds'));
  if (endpoint.includeCost) parts.push(translate('webhook.row.withCost'));
  const result = endpoint.lastResult;
  if (result) parts.push(resultText(result, translate, lang));
  return parts.join(' · ');
}

function resultText(result: DeliveryResult, translate: ReturnType<typeof useT>, lang: Lang): string {
  const when = time(result.at, lang);
  if (result.ok) return translate(result.test ? 'webhook.row.testOk' : 'webhook.row.sentOk', { time: when });
  return translate('webhook.row.failed', { time: when, error: result.error ?? '' });
}

/** Reminder kinds the endpoints want whose own notification switch is off. */
export function silentSources(view: AlertWebhookView): AlertKind[] {
  const wanted = new Set(view.endpoints.filter((endpoint) => endpoint.enabled).flatMap((endpoint) => endpoint.kinds));
  return ALERT_KINDS.filter((kind) => wanted.has(kind) && view.sources[kind] === false);
}

/**
 * Settings › budget section: forwards the desktop reminders to chat robots or a JSON hook.
 * Off by default; addresses and secrets go straight to the OS keychain.
 */
export function AlertWebhookCard() {
  const t = useT();
  const lang = useLang();
  const { view, loaded, busy, error, testing, setEnabled, save, remove, test } = useAlertWebhooks();
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [formError, setFormError] = useState('');
  const [testNote, setTestNote] = useState<{ id: string; ok: boolean; text: string } | null>(null);
  const disabled = !loaded || busy;
  const editing = draft.id ? view.endpoints.find((endpoint) => endpoint.id === draft.id) : undefined;
  const signed = SIGNED_PLATFORMS.has(draft.platform);
  const keepsUrl = Boolean(editing && editing.platform === draft.platform);
  const full = !draft.id && view.endpoints.length >= view.maxEndpoints;
  const silent = view.enabled ? silentSources(view) : [];

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!draft.url.trim() && !keepsUrl) {
      setFormError(t('webhook.form.urlRequired'));
      return;
    }
    setFormError('');
    const ok = await save({
      id: draft.id ?? undefined,
      platform: draft.platform,
      name: draft.name,
      enabled: draft.enabled,
      kinds: draft.kinds,
      includeCost: draft.includeCost,
      url: draft.url.trim() || undefined,
      secret: signed && draft.secret ? draft.secret : undefined,
      clearSecret: signed && draft.clearSecret,
    });
    if (ok) setDraft(EMPTY_DRAFT);
  };

  const edit = (endpoint: WebhookEndpoint) => {
    setFormError('');
    setDraft({
      id: endpoint.id,
      platform: endpoint.platform,
      name: endpoint.name,
      url: '',
      secret: '',
      clearSecret: false,
      kinds: endpoint.kinds,
      includeCost: endpoint.includeCost,
      enabled: endpoint.enabled,
    });
  };

  const toggleKind = (kind: AlertKind, on: boolean) => {
    setDraft({
      ...draft,
      kinds: ALERT_KINDS.filter((item) => (item === kind ? on : draft.kinds.includes(item))),
    });
  };

  const runTest = async (endpoint: WebhookEndpoint) => {
    setTestNote(null);
    const result = await test(endpoint.id);
    setTestNote({
      id: endpoint.id,
      ok: result.ok,
      text: result.ok ? t('webhook.test.ok') : t('webhook.test.failed', { error: result.error ?? '' }),
    });
  };

  return (
    <SettingsCard title={t('webhook.card.title')} description={t('webhook.card.description')}>
      <SettingsGroup>
        <SettingsToggleRow
          label={t('webhook.enabled.label')}
          hint={t('webhook.enabled.hint')}
          icon={Webhook}
          checked={view.enabled}
          disabled={disabled}
          busy={busy}
          onChange={(enabled) => void setEnabled(enabled)}
        />
        {silent.length > 0 && (
          <p className="settings-hint alert-webhook-note" role="note">
            {t('webhook.silentSources', { kinds: silent.map((kind) => KIND_LABELS[kind]).join(t('webhook.row.separator')) })}
          </p>
        )}
        {view.endpoints.length === 0 && loaded && (
          <SettingsRow label={t('webhook.empty.label')} hint={t('webhook.empty.hint')} icon={Send}>
            <span />
          </SettingsRow>
        )}
        {view.endpoints.map((endpoint) => (
          <div key={endpoint.id} className="alert-webhook-endpoint" data-enabled={endpoint.enabled}>
            <SettingsRow label={endpoint.name} hint={endpointSummary(endpoint, t, lang)} icon={Send}>
              <div className="settings-inline-actions">
                <button
                  type="button"
                  className="secondary-inline"
                  disabled={disabled || testing !== null}
                  aria-label={t('webhook.action.testAria', { name: endpoint.name })}
                  onClick={() => void runTest(endpoint)}
                >
                  {testing === endpoint.id ? t('webhook.action.testing') : t('webhook.action.test')}
                </button>
                <button
                  type="button"
                  className="secondary-inline"
                  aria-pressed={endpoint.enabled}
                  disabled={disabled}
                  onClick={() => void save({
                    id: endpoint.id,
                    platform: endpoint.platform,
                    name: endpoint.name,
                    enabled: !endpoint.enabled,
                    kinds: endpoint.kinds,
                    includeCost: endpoint.includeCost,
                  })}
                >
                  {endpoint.enabled ? t('webhook.action.disable') : t('webhook.action.enable')}
                </button>
                <button
                  type="button"
                  className="secondary-inline"
                  disabled={disabled}
                  aria-label={t('webhook.action.editAria', { name: endpoint.name })}
                  title={t('webhook.action.edit')}
                  onClick={() => edit(endpoint)}
                >
                  <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="secondary-inline"
                  disabled={disabled}
                  aria-label={t('webhook.action.deleteAria', { name: endpoint.name })}
                  title={t('webhook.action.delete')}
                  onClick={() => {
                    if (draft.id === endpoint.id) setDraft(EMPTY_DRAFT);
                    void remove(endpoint.id);
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </div>
            </SettingsRow>
            {testNote?.id === endpoint.id && (
              <p className={testNote.ok ? 'settings-hint' : 'settings-error'} role="status" aria-live="polite">
                {testNote.text}
              </p>
            )}
          </div>
        ))}
        {error && <p className="settings-error" role="alert">{error}</p>}
      </SettingsGroup>

      <form className="alert-webhook-form" onSubmit={(event) => void submit(event)} aria-label={draft.id ? t('webhook.form.editTitle') : t('webhook.form.addTitle')}>
        <h4 className="alert-webhook-form-title">{draft.id ? t('webhook.form.editTitle') : t('webhook.form.addTitle')}</h4>
        <SettingsGroup>
          <SettingsRow label={t('webhook.form.target')} hint={t('webhook.form.targetHint')} wideControl>
            <div className="alert-webhook-fields">
              <select
                className="settings-select"
                aria-label={t('webhook.form.platform')}
                value={draft.platform}
                onChange={(event) => setDraft({ ...draft, platform: event.target.value as WebhookPlatform, url: '', secret: '', clearSecret: false })}
              >
                {WEBHOOK_PLATFORMS.map((platform) => <option key={platform} value={platform}>{PLATFORM_LABELS[platform]}</option>)}
              </select>
              <input
                className="settings-input"
                aria-label={t('webhook.form.name')}
                placeholder={t('webhook.form.namePlaceholder')}
                maxLength={32}
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              />
            </div>
          </SettingsRow>
          <SettingsRow
            label={t('webhook.form.url')}
            hint={keepsUrl ? t('webhook.form.urlKeepHint', { host: editing?.urlHint ?? '' }) : t('webhook.form.urlHint')}
            wideControl
          >
            <input
              className="settings-input alert-webhook-url"
              type="password"
              autoComplete="off"
              spellCheck={false}
              aria-label={t('webhook.form.url')}
              placeholder={keepsUrl ? t('webhook.form.urlKeepPlaceholder') : URL_PLACEHOLDERS[draft.platform]}
              value={draft.url}
              onChange={(event) => setDraft({ ...draft, url: event.target.value })}
            />
          </SettingsRow>
          {signed && (
            <SettingsRow
              label={t('webhook.form.secret')}
              hint={draft.platform === 'generic' ? t('webhook.form.secretHintGeneric') : t('webhook.form.secretHint')}
              wideControl
            >
              <div className="alert-webhook-fields">
                <input
                  className="settings-input"
                  type="password"
                  autoComplete="off"
                  aria-label={t('webhook.form.secret')}
                  placeholder={editing?.hasSecret && keepsUrl ? t('webhook.form.secretKeepPlaceholder') : t('webhook.form.secretPlaceholder')}
                  value={draft.secret}
                  disabled={draft.clearSecret}
                  onChange={(event) => setDraft({ ...draft, secret: event.target.value })}
                />
                {editing?.hasSecret && keepsUrl && (
                  <label className="alert-webhook-check">
                    <input
                      type="checkbox"
                      checked={draft.clearSecret}
                      onChange={(event) => setDraft({ ...draft, clearSecret: event.target.checked, secret: '' })}
                    />
                    {t('webhook.form.clearSecret')}
                  </label>
                )}
              </div>
            </SettingsRow>
          )}
          <SettingsRow label={t('webhook.form.kinds')} hint={t('webhook.form.kindsHint')} wideControl>
            <fieldset className="alert-webhook-kinds" aria-label={t('webhook.form.kinds')}>
              {ALERT_KINDS.map((kind) => {
                const unavailable = view.sources[kind] === null;
                return (
                  <label key={kind} className="alert-webhook-check" title={unavailable ? t('webhook.form.kindUnavailable') : undefined}>
                    <input
                      type="checkbox"
                      checked={draft.kinds.includes(kind)}
                      disabled={unavailable}
                      onChange={(event) => toggleKind(kind, event.target.checked)}
                    />
                    {KIND_LABELS[kind]}
                  </label>
                );
              })}
            </fieldset>
          </SettingsRow>
          <SettingsRow label={t('webhook.form.cost')} hint={t('webhook.form.costHint')} wideControl>
            <label className="alert-webhook-check">
              <input
                type="checkbox"
                checked={draft.includeCost}
                onChange={(event) => setDraft({ ...draft, includeCost: event.target.checked })}
              />
              {t('webhook.form.costCheck')}
            </label>
          </SettingsRow>
          {formError && <p className="settings-error" role="alert">{formError}</p>}
          <SettingsActionRow>
            <button
              type="submit"
              className="primary-inline"
              disabled={disabled || full}
              title={full ? t('webhook.form.full', { max: view.maxEndpoints }) : undefined}
            >
              {draft.id ? t('webhook.form.save') : t('webhook.form.add')}
            </button>
            {draft.id && (
              <button type="button" className="secondary-inline" onClick={() => { setDraft(EMPTY_DRAFT); setFormError(''); }}>
                {t('webhook.form.cancel')}
              </button>
            )}
          </SettingsActionRow>
        </SettingsGroup>
      </form>
    </SettingsCard>
  );
}
