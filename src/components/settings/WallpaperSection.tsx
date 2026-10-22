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
    <SettingsSection id="wallpaper" title="壁纸">
      {consentRequired && (
        <div className="wallpaper-consent" role="alert" aria-busy={activeAction !== null || undefined}>
          <ShieldAlert className="h-5 w-5" aria-hidden="true" />
          <div>
            <strong>历史壁纸自动化已暂停</strong>
            <p>旧版设置缺少系统壁纸授权记录。确认后才会恢复历史开关；在此之前启动和定时任务都不会写入系统壁纸。</p>
          </div>
          <div className="wallpaper-consent-actions">
            <button
              className="primary-inline"
              type="button"
              disabled={actionLocked}
              aria-busy={restoreConsentBusy || undefined}
              aria-label={restoreConsentBusy ? '正在确认并恢复历史壁纸设置' : '确认并保留原设置'}
              title={restoreConsentBusy ? '正在确认并恢复历史壁纸设置' : '确认并保留原设置'}
              onClick={() => void runAction('restore-consent', () => props.onConsentDecision(true))}
            >
              {restoreConsentBusy && <LoaderCircle className="h-4 w-4 animate-spin" />}
              {restoreConsentBusy ? '确认中…' : '确认并保留原设置'}
            </button>
            <button
              className="secondary-inline"
              type="button"
              disabled={actionLocked}
              aria-busy={disableConsentBusy || undefined}
              aria-label={disableConsentBusy ? '正在关闭历史壁纸自动化' : '全部保持关闭'}
              title={disableConsentBusy ? '正在关闭历史壁纸自动化' : '全部保持关闭'}
              onClick={() => void runAction('disable-consent', () => props.onConsentDecision(false))}
            >
              {disableConsentBusy && <LoaderCircle className="h-4 w-4 animate-spin" />}
              {disableConsentBusy ? '处理中…' : '全部保持关闭'}
            </button>
          </div>
        </div>
      )}
      <div className="wallpaper-status" role="status" aria-live="polite">
        <div>
          <span className="wallpaper-status-eyebrow">桌面状态</span>
          <h3>{consentRequired ? '等待授权确认' : props.wallpaperError ? '设置已保存，桌面应用失败' : !desktopEnabled ? '已暂停' : cloudUnavailable ? '已启用 · 云端数据待就绪' : `已启用 · ${dynamic ? '动态桌面' : '静态图片'}`}</h3>
          <p>{!desktopEnabled
            ? `桌面不会自动更新。${dynamic ? '动态桌面偏好已保留，打开下方总开关后才会生效。' : '选择呈现方式后，打开下方总开关即可启用。'}`
            : dynamic ? '在主显示器的原有壁纸上显示用量。数据变化时更新，退出 TokenLedger 后消失。' : '将今日用量生成图片并设置为系统壁纸。暂停更新后，当前图片仍会保留。'}</p>
        </div>
        <span className="wallpaper-state-badge">{busy.settings ? '保存中…' : '本机偏好'}</span>
      </div>
      {props.wallpaperError && <p className="wallpaper-error" role="alert">{props.wallpaperError}。{desktopEnabled ? '可使用“立即应用”重试。' : '请退出并重新打开 TokenLedger，以重新应用关闭设置。'}</p>}
      <SettingsCard title="桌面壁纸">
        <SettingsGroup>
          <SettingsToggleRow
            label="启用桌面壁纸"
            hint="总开关。关闭后暂停自动更新，保留你选择的呈现方式。"
            icon={ImageIcon}
            checked={appSettings.wallpaper_desktop_enabled}
            disabled={actionLocked || consentRequired}
            busy={busy.settings}
            onChange={(checked) => props.onSettingChange('wallpaper_desktop_enabled', checked)}
          />
          {props.showDynamicBackgroundControls && (
            <fieldset className="wallpaper-mode-options" disabled={actionLocked || consentRequired}>
              <legend>呈现方式</legend>
              <label>
                <input type="radio" name="wallpaper-mode" value="dynamic" checked={dynamic}
                  onChange={() => props.onSettingChange('wallpaper_dynamic_bg_enabled', true)} />
                <span><strong>动态桌面</strong><small>保留原壁纸，用量随数据更新 · 仅主显示器</small></span>
              </label>
              <label>
                <input type="radio" name="wallpaper-mode" value="static" checked={!dynamic}
                  onChange={() => props.onSettingChange('wallpaper_dynamic_bg_enabled', false)} />
                <span><strong>静态图片</strong><small>定期生成系统壁纸 · 退出后图片仍保留</small></span>
              </label>
            </fieldset>
          )}
          {!dynamic && <SettingsRow label="自动更新间隔" hint="单位：秒，最小 15 秒；不会改变日志扫描频率" icon={Timer}>
            <input className="settings-number" type="number" min={15} max={86400}
              value={appSettings.desktop_interval_secs} aria-label="桌面壁纸刷新间隔（秒）"
              onChange={(event) => props.onSettingChangeDebounced('desktop_interval_secs', Number(event.target.value))}
              onBlur={() => props.onFlushSettingChange()} disabled={actionLocked || !desktopEnabled} />
          </SettingsRow>}
          {dynamic && <p className="wallpaper-note">数据变化后更新，可见时每 5 分钟校准。没有持续动画，也不会每秒重绘桌面。</p>}
          <WallpaperPreview dynamic={dynamic}
            refreshKey={`${appSettings.wallpaper_use_cloud}|${appSettings.wallpaper_device_filter}`} />
          <div className="wallpaper-actions">
            {props.onRefreshWallpaper && <button className="primary-inline" type="button"
              disabled={actionLocked || !desktopEnabled || cloudUnavailable}
              onClick={() => void props.onRefreshWallpaper?.()}>
              {busy.wallpaper ? '应用中…' : '立即应用'}
            </button>}
          </div>
        </SettingsGroup>
      </SettingsCard>

      {props.showLockscreenControls && (
        <SettingsCard title="锁屏壁纸">
          <SettingsGroup>
            <SettingsToggleRow
              label="自动更新锁屏壁纸"
              icon={Monitor}
              checked={appSettings.wallpaper_lockscreen_enabled}
              disabled={busy.settings || consentRequired}
              busy={busy.settings}
              onChange={(checked) => props.onSettingChange('wallpaper_lockscreen_enabled', checked)}
            />
            <SettingsRow label="锁屏壁纸刷新" hint="最小 30 秒" icon={Timer}>
              <input
                className="settings-number"
                type="number"
                min={30}
                value={appSettings.lockscreen_interval_secs}
                aria-label="锁屏壁纸刷新间隔（秒）"
                onChange={(event) => props.onSettingChangeDebounced('lockscreen_interval_secs', Number(event.target.value))}
                onBlur={() => props.onFlushSettingChange()}
                disabled={busy.settings || consentRequired}
              />
            </SettingsRow>
          </SettingsGroup>
        </SettingsCard>
      )}

      <SettingsCard title="数据来源">
        <SettingsGroup>
          <SettingsRow label="壁纸用量来源" hint="独立于主看板的筛选，只影响壁纸显示的数据。" icon={Cloud}>
            <select className="settings-select" aria-label="壁纸用量来源" value={appSettings.wallpaper_use_cloud ? 'cloud' : 'local'}
              disabled={actionLocked || consentRequired}
              onChange={(event) => props.onSettingChange('wallpaper_use_cloud', event.target.value === 'cloud')}>
              <option value="local">这台电脑</option>
              <option value="cloud" disabled={!props.cloudWallpaperReady}>云端汇总{!props.cloudWallpaperReady ? '（待就绪）' : ''}</option>
            </select>
          </SettingsRow>
          {!props.cloudWallpaperReady && <div className="wallpaper-note">
            <p>{props.cloudWallpaperHint}。{cloudUnavailable ? '当前仍选择云端，不会自动改用本机数据。' : '你可以先使用这台电脑的数据。'}</p>
            {props.onOpenCloudSection && <button className="secondary-inline" type="button" onClick={props.onOpenCloudSection}>前往云端账户</button>}
          </div>}
          {appSettings.wallpaper_use_cloud && (
            <SettingsRow label="壁纸统计设备范围" icon={Monitor}>
              <select
                className="settings-select"
                value={deviceFilter}
                aria-label="壁纸统计设备范围"
                onChange={(event) => props.onSettingChange('wallpaper_device_filter', event.target.value)}
                disabled={busy.settings || consentRequired}
              >
                <option value="all_cloud">全部设备</option>
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

      <SettingsCard title="维护">
        <SettingsGroup>
          <div className="wallpaper-history-cleanup"><p className="wallpaper-note">仅删除 TokenLedger 生成的历史图片。保留当前图片、桌面设置和原有壁纸。</p>
            <SettingsActionRow busy={actionLocked}>
              <button
                className="secondary-inline"
                type="button"
                onClick={() => void runAction('cleanup', props.onCleanupWallpaper)}
                disabled={actionLocked}
                aria-busy={cleanupBusy || undefined}
                aria-label={cleanupPending ? '等待确认清理历史壁纸' : cleanupBusy ? '正在清理历史壁纸' : '清理历史壁纸'}
                title={cleanupPending ? '等待确认清理历史壁纸' : cleanupBusy ? '正在清理历史壁纸' : '清理历史壁纸'}
              >
                {cleanupBusy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                {cleanupPending ? '等待确认…' : cleanupBusy ? '清理中…' : '清理历史壁纸'}
              </button>
            </SettingsActionRow>
          </div>
        </SettingsGroup>
      </SettingsCard>
    </SettingsSection>
  );
}

export default WallpaperSection;
