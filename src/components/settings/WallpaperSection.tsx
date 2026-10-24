import { useState } from 'react';
import { WallpaperPreview } from './WallpaperPreview';
import '../../styles/wallpaper-settings.css';
import { Cloud, Image as ImageIcon, LoaderCircle, Monitor, ShieldAlert, Timer, Trash2 } from 'lucide-react';
import type { AppSettings, BusyState } from '../../types';
import {
  SettingsActionRow,
  SettingsCard,
  SettingsGroup,
  SettingsRow,
  SettingsSection,
  SettingsToggleRow,
} from './SettingsPrimitives';
import { t, useLang } from '../../i18n';

export interface WallpaperSectionProps {
  appSettings: AppSettings;
  busy: BusyState;
  deviceList: string[];
  showDynamicBackgroundControls: boolean;
  showLockscreenControls: boolean;
  cloudWallpaperReady: boolean;
  cloudWallpaperHint: string;
  onSettingChange: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
  onSettingChangeDebounced: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
  onFlushSettingChange: () => void;
  onConsentDecision: (restoreHistoricalChoices: boolean) => void | Promise<void>;
  onCleanupWallpaper: () => void | Promise<void>;
  onRefreshWallpaper?: () => void | Promise<void>;
  onOpenCloudSection?: () => void;
  wallpaperError?: string;
}

export function WallpaperSection(props: WallpaperSectionProps) {
  useLang();
  const { appSettings, busy } = props;
  const [activeAction, setActiveAction] = useState<'restore-consent' | 'disable-consent' | 'cleanup' | null>(null);
  const [pendingAction, setPendingAction] = useState<'cleanup' | null>(null);
  const consentRequired = appSettings.wallpaper_consent_version < 1;
  const deviceFilter =
    appSettings.wallpaper_device_filter === 'all_cloud' || props.deviceList.includes(appSettings.wallpaper_device_filter)
      ? appSettings.wallpaper_device_filter
      : 'all_cloud';

  const runAction = async (
    action: 'restore-consent' | 'disable-consent' | 'cleanup',
    callback: () => void | Promise<void>,
  ) => {
    if (activeAction !== null || busy.settings) return;
    if (action === 'cleanup') setPendingAction(action);
    else setActiveAction(action);
    try {
      await callback();
    } finally {
      if (action === 'cleanup') setPendingAction(null);
      else setActiveAction(null);
    }
  };

  const restoreConsentBusy = activeAction === 'restore-consent';
  const disableConsentBusy = activeAction === 'disable-consent';
  const cleanupPending = pendingAction === 'cleanup' && !busy.settings;
  const cleanupBusy = pendingAction === 'cleanup' && busy.settings;
  const desktopEnabled = appSettings.wallpaper_desktop_enabled && !consentRequired;
  const dynamic = props.showDynamicBackgroundControls && appSettings.wallpaper_dynamic_bg_enabled;
  const cloudUnavailable = appSettings.wallpaper_use_cloud && !props.cloudWallpaperReady;
  const actionLocked = busy.wallpaper || busy.settings || activeAction !== null || pendingAction !== null;

  return (
    <SettingsSection id="wallpaper" title={t('wall.title')}>
      {consentRequired && (
        <div className="wallpaper-consent" role="alert" aria-busy={activeAction !== null || undefined}>
          <ShieldAlert className="h-5 w-5" aria-hidden="true" />
          <div>
            <strong>{t('wall.consent.title')}</strong>
            <p>{t('wall.consent.body')}</p>
          </div>
          <div className="wallpaper-consent-actions">
            <button
              className="primary-inline"
              type="button"
              disabled={actionLocked}
              aria-busy={restoreConsentBusy || undefined}
              aria-label={restoreConsentBusy ? t('wall.consent.restoringAria') : t('wall.consent.restore')}
              title={restoreConsentBusy ? t('wall.consent.restoringAria') : t('wall.consent.restore')}
              onClick={() => void runAction('restore-consent', () => props.onConsentDecision(true))}
            >
              {restoreConsentBusy && <LoaderCircle className="h-4 w-4 animate-spin" />}
              {restoreConsentBusy ? t('wall.consent.confirming') : t('wall.consent.restore')}
            </button>
            <button
              className="secondary-inline"
              type="button"
              disabled={actionLocked}
              aria-busy={disableConsentBusy || undefined}
              aria-label={disableConsentBusy ? t('wall.consent.disablingAria') : t('wall.consent.disable')}
              title={disableConsentBusy ? t('wall.consent.disablingAria') : t('wall.consent.disable')}
              onClick={() => void runAction('disable-consent', () => props.onConsentDecision(false))}
            >
              {disableConsentBusy && <LoaderCircle className="h-4 w-4 animate-spin" />}
              {disableConsentBusy ? t('wall.consent.disabling') : t('wall.consent.disable')}
            </button>
          </div>
        </div>
      )}
      <div className="wallpaper-status" role="status" aria-live="polite">
        <div>
          <span className="wallpaper-status-eyebrow">{t('wall.status.eyebrow')}</span>
          <h3>{t(consentRequired ? 'wall.status.consent' : props.wallpaperError ? 'wall.status.failed' : !desktopEnabled ? 'wall.status.paused' : cloudUnavailable ? 'wall.status.cloudPending' : dynamic ? 'wall.status.onDynamic' : 'wall.status.onStatic')}</h3>
          <p>{!desktopEnabled
            ? t(dynamic ? 'wall.status.offDynamic' : 'wall.status.offStatic')
            : t(dynamic ? 'wall.status.dynamicNote' : 'wall.status.staticNote')}</p>
        </div>
        <span className="wallpaper-state-badge">{busy.settings ? t('wall.saving') : t('wall.localPref')}</span>
      </div>
      {props.wallpaperError && <p className="wallpaper-error" role="alert">{t(desktopEnabled ? 'wall.error.retry' : 'wall.error.reopen', { error: props.wallpaperError })}</p>}
      <SettingsCard title={t('wall.desktop.card')}>
        <SettingsGroup>
          <SettingsToggleRow
            label={t('wall.desktop.enable')}
            hint={t('wall.desktop.enableHint')}
            icon={ImageIcon}
            checked={appSettings.wallpaper_desktop_enabled}
            disabled={actionLocked || consentRequired}
            busy={busy.settings}
            onChange={(checked) => props.onSettingChange('wallpaper_desktop_enabled', checked)}
          />
          {props.showDynamicBackgroundControls && (
            <fieldset className="wallpaper-mode-options" disabled={actionLocked || consentRequired}>
              <legend>{t('wall.style')}</legend>
              <label>
                <input type="radio" name="wallpaper-mode" value="dynamic" checked={dynamic}
                  onChange={() => props.onSettingChange('wallpaper_dynamic_bg_enabled', true)} />
                <span><strong>{t('wall.style.dynamic')}</strong><small>{t('wall.style.dynamicHint')}</small></span>
              </label>
              <label>
                <input type="radio" name="wallpaper-mode" value="static" checked={!dynamic}
                  onChange={() => props.onSettingChange('wallpaper_dynamic_bg_enabled', false)} />
                <span><strong>{t('wall.style.static')}</strong><small>{t('wall.style.staticHint')}</small></span>
              </label>
            </fieldset>
          )}
          {!dynamic && <SettingsRow label={t('wall.interval')} hint={t('wall.interval.hint')} icon={Timer}>
            <input className="settings-number" type="number" min={15} max={86400}
              value={appSettings.desktop_interval_secs} aria-label={t('wall.interval.aria')}
              onChange={(event) => props.onSettingChangeDebounced('desktop_interval_secs', Number(event.target.value))}
              onBlur={() => props.onFlushSettingChange()} disabled={actionLocked || !desktopEnabled} />
          </SettingsRow>}
          {dynamic && <p className="wallpaper-note">{t('wall.dynamic.note')}</p>}
          <WallpaperPreview dynamic={dynamic}
            refreshKey={`${appSettings.wallpaper_use_cloud}|${appSettings.wallpaper_device_filter}`} />
          <div className="wallpaper-actions">
            {props.onRefreshWallpaper && <button className="primary-inline" type="button"
              disabled={actionLocked || !desktopEnabled || cloudUnavailable}
              onClick={() => void props.onRefreshWallpaper?.()}>
              {busy.wallpaper ? t('wall.applying') : t('wall.apply')}
            </button>}
          </div>
        </SettingsGroup>
      </SettingsCard>

      {props.showLockscreenControls && (
        <SettingsCard title={t('wall.lock.card')}>
          <SettingsGroup>
            <SettingsToggleRow
              label={t('wall.lock.enable')}
              icon={Monitor}
              checked={appSettings.wallpaper_lockscreen_enabled}
              disabled={busy.settings || consentRequired}
              busy={busy.settings}
              onChange={(checked) => props.onSettingChange('wallpaper_lockscreen_enabled', checked)}
            />
            <SettingsRow label={t('wall.lock.interval')} hint={t('wall.lock.intervalHint')} icon={Timer}>
              <input
                className="settings-number"
                type="number"
                min={30}
                value={appSettings.lockscreen_interval_secs}
                aria-label={t('wall.lock.intervalAria')}
                onChange={(event) => props.onSettingChangeDebounced('lockscreen_interval_secs', Number(event.target.value))}
                onBlur={() => props.onFlushSettingChange()}
                disabled={busy.settings || consentRequired}
              />
            </SettingsRow>
          </SettingsGroup>
        </SettingsCard>
      )}

      <SettingsCard title={t('wall.source.card')}>
        <SettingsGroup>
          <SettingsRow label={t('wall.source')} hint={t('wall.source.hint')} icon={Cloud}>
            <select className="settings-select" aria-label={t('wall.source')} value={appSettings.wallpaper_use_cloud ? 'cloud' : 'local'}
              disabled={actionLocked || consentRequired}
              onChange={(event) => props.onSettingChange('wallpaper_use_cloud', event.target.value === 'cloud')}>
              <option value="local">{t('wall.source.local')}</option>
              <option value="cloud" disabled={!props.cloudWallpaperReady}>{t(props.cloudWallpaperReady ? 'wall.source.cloud' : 'wall.source.cloudPending')}</option>
            </select>
          </SettingsRow>
          {!props.cloudWallpaperReady && <div className="wallpaper-note">
            <p>{t(cloudUnavailable ? 'wall.source.stillCloud' : 'wall.source.useLocal', { hint: props.cloudWallpaperHint })}</p>
            {props.onOpenCloudSection && <button className="secondary-inline" type="button" onClick={props.onOpenCloudSection}>{t('wall.source.openCloud')}</button>}
          </div>}
          {appSettings.wallpaper_use_cloud && (
            <SettingsRow label={t('wall.devices')} icon={Monitor}>
              <select
                className="settings-select"
                value={deviceFilter}
                aria-label={t('wall.devices')}
                onChange={(event) => props.onSettingChange('wallpaper_device_filter', event.target.value)}
                disabled={busy.settings || consentRequired}
              >
                <option value="all_cloud">{t('wall.devices.all')}</option>
                {props.deviceList.map((machine) => (
                  <option key={machine} value={machine}>
                    {machine}
                  </option>
                ))}
              </select>
            </SettingsRow>
          )}
        </SettingsGroup>
      </SettingsCard>

      <SettingsCard title={t('wall.maintenance')}>
        <SettingsGroup>
          <div className="wallpaper-history-cleanup"><p className="wallpaper-note">{t('wall.cleanup.note')}</p>
            <SettingsActionRow busy={actionLocked}>
              <button
                className="secondary-inline"
                type="button"
                onClick={() => void runAction('cleanup', props.onCleanupWallpaper)}
                disabled={actionLocked}
                aria-busy={cleanupBusy || undefined}
                aria-label={cleanupPending ? t('wall.cleanup.pending') : cleanupBusy ? t('wall.cleanup.busyAria') : t('wall.cleanup')}
                title={cleanupPending ? t('wall.cleanup.pending') : cleanupBusy ? t('wall.cleanup.busyAria') : t('wall.cleanup')}
              >
                {cleanupBusy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                {cleanupPending ? t('wall.cleanup.pendingShort') : cleanupBusy ? t('wall.cleanup.busy') : t('wall.cleanup')}
              </button>
            </SettingsActionRow>
          </div>
        </SettingsGroup>
      </SettingsCard>
    </SettingsSection>
  );
}

export default WallpaperSection;
