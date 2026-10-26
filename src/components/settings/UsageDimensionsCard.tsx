import { useEffect, useState } from 'react';
import { Gauge, Layers, MessagesSquare } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import type { AppSettings, BusyState } from '../../types';
import { t, useT } from '../../i18n';
import { DisclosurePanel, SettingsCard, SettingsGroup, SettingsToggleRow } from './SettingsPrimitives';

/** Mirrors `usage_dimensions_publish::DimensionStatus` (usage-dimensions-cloud-v1 §5). */
export interface UsageDimensionStatus {
  state: 'off' | 'signed-out' | 'not-deployed' | 'ok' | 'error' | 'starting' | 'clearing';
  lastUploadedAt: string | null;
  error: string | null;
}

export interface UsageDimensionsStatus {
  sessions: UsageDimensionStatus;
  providers: UsageDimensionStatus;
  context: UsageDimensionStatus;
}

export type UsageDimensionKey = keyof UsageDimensionsStatus;

type DimensionSettingKey =
  | 'usage_dimension_sessions_enabled'
  | 'usage_dimension_providers_enabled'
  | 'usage_dimension_context_enabled';

interface DimensionSpec {
  key: UsageDimensionKey;
  setting: DimensionSettingKey;
  labelKey: 'usageDimensions.sessions.label' | 'usageDimensions.providers.label' | 'usageDimensions.context.label';
  fieldsKey: 'usageDimensions.sessions.fields' | 'usageDimensions.providers.fields' | 'usageDimensions.context.fields';
  icon: LucideIcon;
}

export const USAGE_DIMENSIONS: DimensionSpec[] = [
  { key: 'sessions', setting: 'usage_dimension_sessions_enabled', labelKey: 'usageDimensions.sessions.label', fieldsKey: 'usageDimensions.sessions.fields', icon: MessagesSquare },
  { key: 'providers', setting: 'usage_dimension_providers_enabled', labelKey: 'usageDimensions.providers.label', fieldsKey: 'usageDimensions.providers.fields', icon: Layers },
  { key: 'context', setting: 'usage_dimension_context_enabled', labelKey: 'usageDimensions.context.label', fieldsKey: 'usageDimensions.context.fields', icon: Gauge },
];

const STATUS_POLL_MS = 5_000;

function ago(iso: string | null, now: number): string {
  const at = iso ? Date.parse(iso) : Number.NaN;
  if (!Number.isFinite(at)) return '';
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 10) return t('usageDimensions.justNow');
  if (seconds < 60) return t('usageDimensions.secondsAgo', { count: seconds });
  if (seconds < 3600) return t('usageDimensions.minutesAgo', { count: Math.round(seconds / 60) });
  return t('usageDimensions.hoursAgo', { count: Math.round(seconds / 3600) });
}

/**
 * Off still shows pending cleanup, failure and sign-out state. Raw backend errors are
 * deliberately not rendered: they can contain response details from the cloud client.
 */
export function usageDimensionHint(
  spec: Pick<DimensionSpec, 'fieldsKey'>,
  status: UsageDimensionStatus | null,
  enabled: boolean,
  now = Date.now(),
): string {
  const state = status?.state ?? 'off';
  if (state === 'clearing') return t('usageDimensions.clearing');
  if (!enabled) {
    if (state === 'signed-out') return t('usageDimensions.clearSignedOut');
    if (state === 'error') return t('usageDimensions.clearError');
    if (state === 'not-deployed') return t('usageDimensions.notDeployed');
    return t('usageDimensions.off', { fields: t(spec.fieldsKey) });
  }
  if (!status || state === 'off' || state === 'starting') return t('usageDimensions.starting');
  switch (state) {
    case 'signed-out':
      return t('usageDimensions.signedOut');
    case 'not-deployed':
      return t('usageDimensions.notDeployed');
    case 'error':
      return t('usageDimensions.error');
    case 'ok': {
      const when = ago(status.lastUploadedAt, now);
      return when ? t('usageDimensions.okWhen', { when }) : t('usageDimensions.ok');
    }
    default:
      return '';
  }
}

interface UsageDimensionsCardProps {
  appSettings: AppSettings;
  busy: BusyState;
  onSettingChange: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
}

/** 「数据与帮助」里的云端用量维度：会话、账号与 Context 构成，供 Android 只读查看。 */
export function UsageDimensionsCard({ appSettings, busy, onSettingChange }: UsageDimensionsCardProps) {
  const translate = useT();
  const [status, setStatus] = useState<UsageDimensionsStatus | null>(null);

  // Keep polling while off: cleanup can still be pending after a switch flips.
  useEffect(() => {
    let cancelled = false;
    let requestId = 0;
    const read = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      const currentRequest = ++requestId;
      invoke<UsageDimensionsStatus>('usage_dimensions_publish_status')
        .then((next) => {
          if (!cancelled && currentRequest === requestId) setStatus(next);
        })
        .catch(() => {
          if (!cancelled && currentRequest === requestId) {
            const failed: UsageDimensionStatus = { state: 'error', lastUploadedAt: null, error: null };
            setStatus({ sessions: failed, providers: failed, context: failed });
          }
        });
    };
    read();
    const timer = setInterval(read, STATUS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [
    appSettings.usage_dimension_sessions_enabled,
    appSettings.usage_dimension_providers_enabled,
    appSettings.usage_dimension_context_enabled,
  ]);

  return (
    <SettingsCard title={translate('usageDimensions.title')} description={translate('usageDimensions.description')}>
      <SettingsGroup>
        {USAGE_DIMENSIONS.map((spec) => {
          const enabled = appSettings[spec.setting] === true;
          return (
            <SettingsToggleRow
              key={spec.key}
              label={translate(spec.labelKey)}
              hint={usageDimensionHint(spec, status?.[spec.key] ?? null, enabled)}
              icon={spec.icon}
              checked={enabled}
              disabled={busy.settings}
              busy={busy.settings}
              onChange={(checked) => onSettingChange(spec.setting, checked)}
            />
          );
        })}
        <DisclosurePanel title={translate('usageDimensions.details')}>
          <div className="settings-project-copy">
            <ul>
              <li>{translate('usageDimensions.detailAggregate')}</li>
              <li>{translate('usageDimensions.detailAccounts')}</li>
              <li>{translate('usageDimensions.detailSessions')}</li>
              <li>{translate('usageDimensions.detailRetention')}</li>
              <li>{translate('usageDimensions.detailClear')}</li>
            </ul>
          </div>
        </DisclosurePanel>
      </SettingsGroup>
    </SettingsCard>
  );
}

export default UsageDimensionsCard;
