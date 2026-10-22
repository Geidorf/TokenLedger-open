import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, Circle, Cloud, Eye, EyeOff, KeyRound, LogOut, Mail, RefreshCw, ShieldCheck } from 'lucide-react';
import type { BusyState, CloudConfig, CloudStatus } from '../../types';
import { isMacPlatform } from '../../utils/contracts/statsQuery';
import {
  SettingsActionRow,
  SettingsCard,
  SettingsGroup,
  SettingsRow,
  SettingsSection,
} from './SettingsPrimitives';

export interface CloudAccountSectionProps {
  cloudConfig: CloudConfig;
  cloudStatus: CloudStatus;
  authForm: { email: string; password: string };
  busy: BusyState;
  onConfigChange: (config: CloudConfig) => void;
  onAuthFormChange: (form: { email: string; password: string }) => void;
  onClearPassword: () => void;
  onSaveConfig: (event: React.FormEvent) => void;
  onSync: () => void;
  onSignIn: () => void;
  onSignUp: () => void;
  onSignOut: () => void;
  statusKnown?: boolean;
  statusChecking?: boolean;
  statusError?: string;
  onCheckStatus?: () => void;
  configError: string;
  authError: string;
  setup: {
    configured: boolean;
    authenticated: boolean;
    capabilityVerified: boolean;
    firstSyncCompleted: boolean;
    validating: boolean;
    lastError: string;
  };
  onValidateCapability: () => void;
}

export function firstSyncActionHint(
  setup: Pick<CloudAccountSectionProps['setup'], 'authenticated' | 'capabilityVerified'>,
  syncBusy: boolean,
): string | null {
  if (syncBusy) return '正在同步，请稍候';
  if (!setup.authenticated) return '请先登录云端账户';
  if (!setup.capabilityVerified) return '请先验证 Stats v2';
  return null;
}

export function firstSyncActionLabel(
  setup: Pick<CloudAccountSectionProps['setup'], 'firstSyncCompleted'>,
  syncBusy: boolean,
): string {
  if (syncBusy) return '同步中';
  return setup.firstSyncCompleted ? '同步最新数据' : '执行首次同步';
}

export function capabilityActionLabel(
  setup: Pick<CloudAccountSectionProps['setup'], 'capabilityVerified' | 'validating'>,
): string {
  if (setup.validating) return '验证中';
  return setup.capabilityVerified ? '重新验证 Stats v2' : '验证 Stats v2';
}

export function secureStorageAuthorizationHint(userAgent?: string): string {
  return isMacPlatform(userAgent)
    ? 'macOS 弹出授权时选“始终允许”，输入登录钥匙串密码（不是云端账户密码）；反复弹出请退出旧版，从同一安装包重新打开。'
    : '若系统弹出安全存储授权，请按系统提示完成授权；输入的是本机系统密码，不是云端账户密码。';
}

type AuthAction = 'sign-in' | 'sign-up' | 'sign-out';

export function CloudAccountSection(props: CloudAccountSectionProps) {
  const [keyVisible, setKeyVisible] = useState(false);
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [activeAuthAction, setActiveAuthAction] = useState<AuthAction | null>(null);
  const emailInputRef = useRef<HTMLInputElement>(null);
  const locked = props.cloudStatus.authenticated;
  const firstSyncHint = firstSyncActionHint(props.setup, props.busy.sync);
  const firstSyncHintId = firstSyncHint ? 'cloud-first-sync-hint' : undefined;
  const capabilityBusy = props.setup.validating;
  const capabilityButtonLabel = capabilityBusy ? '验证中…' : capabilityActionLabel(props.setup);
  const capabilityButtonAriaLabel = capabilityBusy ? '正在验证 Stats v2' : capabilityActionLabel(props.setup);
  const statusKnown = props.statusKnown !== false;
  const statusChecking = props.statusChecking ?? false;
  const statusError = props.statusError || '';
  const statusErrorId = statusError ? 'cloud-status-gate-error' : undefined;
  const firstSyncButtonAriaLabel = props.busy.sync
    ? '正在同步云端数据'
    : props.setup.firstSyncCompleted ? '同步最新数据' : '执行首次同步';
  const quickSyncButtonLabel = props.busy.sync ? '同步中…' : '立即同步';
  const quickSyncButtonAriaLabel = props.busy.sync ? '正在同步云端数据' : '立即同步云端数据';
  const configButtonLabel = props.busy.config ? '保存中…' : '保存配置';
  const configButtonAriaLabel = props.busy.config ? '正在保存连接配置' : '保存连接配置';
  const authActionBusy = (action: AuthAction) => props.busy.auth && activeAuthAction === action;
  const signInBusy = authActionBusy('sign-in');
  const signUpBusy = authActionBusy('sign-up');
  const signOutBusy = authActionBusy('sign-out');
  const runAuthAction = (action: AuthAction, callback: () => void) => {
    if (props.busy.auth || props.busy.config) return;
    setActiveAuthAction(action);
    callback();
  };
  const focusLoginField = () => {
    emailInputRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    emailInputRef.current?.focus({ preventScroll: true });
  };
  // 解构出具体回调：规则无法把 `props.onClearPassword` 收窄成稳定引用，只会
  // 要求整个 props 进依赖数组，那会让任意一个 prop 变化都触发一次清空密码。
  const { onClearPassword } = props;
  useEffect(() => () => onClearPassword(), [onClearPassword]);
  useEffect(() => {
    if (!props.busy.auth) setActiveAuthAction(null);
  }, [props.busy.auth]);
  const steps = [
    { label: '保存连接配置', done: props.setup.configured, note: 'Project URL 与公开密钥' },
    { label: '登录账户', done: props.setup.authenticated, note: '建立当前设备会话' },
    { label: '验证 Stats v2', done: props.setup.capabilityVerified, note: '确认已部署迁移版本，无需在应用内执行 SQL' },
    { label: '完成首次同步', done: props.setup.firstSyncCompleted, note: '验证本机数据可上传并回读' },
  ];

  return (
    <SettingsSection id="cloud" title="云端账户">
      <SettingsCard title="连接进度">
        {!statusKnown && (
          <div
            className="cloud-status-gate"
            role={statusError ? 'alert' : 'status'}
            aria-live="polite"
            aria-busy={statusChecking || undefined}
          >
            <div className="cloud-status-gate-copy">
              <ShieldCheck className="h-5 w-5" aria-hidden="true" />
              <div>
                <strong>{statusError ? '云端状态暂未读取' : '云端状态尚未检查'}</strong>
                <p id={statusErrorId}>{statusError || '查看登录状态会读取本机钥匙串，仅在你主动点击后执行。'}</p>
                <p className="cloud-status-gate-hint">
                  {secureStorageAuthorizationHint()}
                </p>
              </div>
            </div>
            <button
              className="primary-inline"
              type="button"
              onClick={() => props.onCheckStatus?.()}
              disabled={statusChecking}
              aria-label={statusChecking ? '正在检查云端账户状态' : statusError ? '重试检查云端账户状态' : '检查云端账户状态'}
              aria-describedby={statusErrorId}
              aria-busy={statusChecking || undefined}
              title={statusChecking ? '正在读取本机安全存储' : '主动读取本机安全存储并检查云端账户状态'}
            >
              {statusChecking && <RefreshCw className="h-4 w-4 animate-spin" />}
              {statusChecking ? '检查中…' : statusError ? '重试检查' : '检查账户状态'}
            </button>
          </div>
        )}
        {statusKnown && (
          <>
            <ol className="cloud-setup-steps" aria-label="云端连接四步进度">
              {steps.map((step, index) => (
                <li className={step.done ? 'is-complete' : ''} key={step.label}>
                  {step.done
                    ? <CheckCircle2 className="h-5 w-5" aria-hidden="true" />
                    : <Circle className="h-5 w-5" aria-hidden="true" />}
                  <span>
                    <strong>{index + 1}. {step.label}</strong>
                    <small>{step.note}</small>
                  </span>
                  <em>{step.done ? '已完成' : '待完成'}</em>
                </li>
              ))}
            </ol>
            <SettingsActionRow busy={capabilityBusy || props.busy.sync}>
              {firstSyncHint && <span className="settings-action-note" id={firstSyncHintId}>{firstSyncHint}</span>}
              {!props.setup.authenticated && (
                <button className="primary-inline" type="button" onClick={focusLoginField}>
                  登录云端账户
                </button>
              )}
              <button
                className="secondary-inline"
                type="button"
                onClick={props.onValidateCapability}
                disabled={!props.setup.authenticated || capabilityBusy || props.busy.sync}
                aria-label={capabilityButtonAriaLabel}
                aria-busy={capabilityBusy || undefined}
                title={capabilityBusy ? capabilityButtonAriaLabel : '验证当前云端是否支持 Stats v2'}
              >
                <ShieldCheck className={`h-4 w-4 ${capabilityBusy ? 'animate-pulse' : ''}`} />
                {capabilityButtonLabel}
              </button>
              <button
                className="primary-inline"
                type="button"
                onClick={props.onSync}
                disabled={!props.setup.authenticated || !props.setup.capabilityVerified || props.busy.sync}
                aria-describedby={firstSyncHintId}
                aria-label={firstSyncButtonAriaLabel}
                aria-busy={props.busy.sync || undefined}
                title={props.busy.sync ? firstSyncButtonAriaLabel : '将本机数据同步到云端'}
              >
                <RefreshCw className={`h-4 w-4 ${props.busy.sync ? 'animate-spin' : ''}`} />
                {firstSyncActionLabel(props.setup, props.busy.sync)}
              </button>
            </SettingsActionRow>
          </>
        )}
        {props.setup.lastError && <p className="form-error cloud-setup-error" role="alert">{props.setup.lastError}</p>}
      </SettingsCard>

      <SettingsCard title="连接配置">
        <form onSubmit={props.onSaveConfig}>
          <SettingsGroup>
            <SettingsRow label="Supabase URL" hint="Project Settings / API 中的 Project URL" icon={Cloud}>
              <input
                className="settings-input"
                type="url"
                placeholder="https://your-project.supabase.co"
                value={props.cloudConfig.supabase_url}
                disabled={locked}
                aria-label="Supabase URL"
                aria-invalid={!!props.configError}
                aria-describedby={props.configError ? 'cloud-config-error' : undefined}
                onChange={(event) => props.onConfigChange({ ...props.cloudConfig, supabase_url: event.target.value })}
              />
            </SettingsRow>
            <SettingsRow label="Publishable Key" hint="只保存 publishable key，不需要 service role key" icon={KeyRound}>
              <input
                className="settings-input"
                type={keyVisible ? 'text' : 'password'}
                value={props.cloudConfig.supabase_key}
                disabled={locked}
                autoComplete="off"
                aria-label="Publishable Key"
                aria-invalid={!!props.configError}
                aria-describedby={props.configError ? 'cloud-config-error' : undefined}
                onChange={(event) => props.onConfigChange({ ...props.cloudConfig, supabase_key: event.target.value })}
              />
              <button
                className="settings-input-affix"
                type="button"
                aria-label={keyVisible ? '隐藏 Key' : '显示 Key'}
                aria-pressed={keyVisible}
                onClick={() => setKeyVisible((visible) => !visible)}
              >
                {keyVisible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </SettingsRow>
            {locked && (
              <SettingsRow label="修改连接配置" hint="如需修改 URL 或 Key，请先退出登录后再编辑保存" icon={ShieldCheck}>
                <span className="settings-value">当前已锁定</span>
              </SettingsRow>
            )}
            {props.configError && (
              <p className="form-error settings-form-feedback" id="cloud-config-error" role="alert">
                {props.configError}
              </p>
            )}
            <SettingsActionRow busy={props.busy.config || props.busy.sync}>
              <button
                className="primary-inline"
                type="submit"
                disabled={props.busy.config || locked}
                aria-label={configButtonAriaLabel}
                aria-busy={props.busy.config || undefined}
                title={props.busy.config ? configButtonAriaLabel : '保存当前 Supabase 连接配置'}
              >
                {props.busy.config && <RefreshCw className="h-4 w-4 animate-spin" />}
                {configButtonLabel}
              </button>
              <button
                className="secondary-inline"
                type="button"
                onClick={props.onSync}
                disabled={props.busy.sync || !props.cloudStatus.authenticated || !props.setup.capabilityVerified}
                aria-describedby={firstSyncHintId}
                aria-label={quickSyncButtonAriaLabel}
                aria-busy={props.busy.sync || undefined}
                title={props.busy.sync ? quickSyncButtonAriaLabel : '立即同步本机数据到云端'}
              >
                <RefreshCw className={`h-4 w-4 ${props.busy.sync ? 'animate-spin' : ''}`} />
                {quickSyncButtonLabel}
              </button>
            </SettingsActionRow>
          </SettingsGroup>
        </form>
      </SettingsCard>

      <SettingsCard title="账户">
        <SettingsGroup>
          <SettingsRow label="配置状态" icon={ShieldCheck}>
            <span className="settings-value">{props.cloudStatus.configured ? '已配置' : '未配置'}</span>
          </SettingsRow>
          <SettingsRow label="登录状态" hint="同一账号可在多设备查看云端汇总" icon={Cloud}>
            <span className="settings-value">
              {props.cloudStatus.authenticated ? props.cloudStatus.email || '已登录' : '未登录'}
            </span>
          </SettingsRow>
          <SettingsRow label="邮箱" icon={Mail}>
            <input
              ref={emailInputRef}
              className="settings-input"
              type="email"
              value={props.authForm.email}
              disabled={locked}
              autoComplete="username"
              aria-label="邮箱"
              aria-invalid={!!props.authError}
              aria-describedby={props.authError ? 'cloud-auth-error' : undefined}
              onChange={(event) => props.onAuthFormChange({ ...props.authForm, email: event.target.value })}
            />
          </SettingsRow>
          <SettingsRow label="密码" icon={KeyRound}>
            <input
              className="settings-input"
              type={passwordVisible ? 'text' : 'password'}
              value={props.authForm.password}
              disabled={locked}
              autoComplete="current-password"
              aria-label="密码"
              aria-invalid={!!props.authError}
              aria-describedby={props.authError ? 'cloud-auth-error' : undefined}
              onChange={(event) => props.onAuthFormChange({ ...props.authForm, password: event.target.value })}
            />
            <button
              className="settings-input-affix"
              type="button"
              aria-label={passwordVisible ? '隐藏密码' : '显示密码'}
              aria-pressed={passwordVisible}
              disabled={locked}
              onClick={() => setPasswordVisible((visible) => !visible)}
            >
              {passwordVisible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </SettingsRow>
          {props.authError && (
            <p className="form-error settings-form-feedback" id="cloud-auth-error" role="alert">
              {props.authError}
            </p>
          )}
          <SettingsActionRow busy={props.busy.auth}>
            <button
              className="primary-inline"
              type="button"
              onClick={() => runAuthAction('sign-in', props.onSignIn)}
              disabled={props.busy.auth || props.busy.config || locked}
              aria-label={signInBusy ? '正在登录云端账户' : '登录'}
              aria-busy={signInBusy || undefined}
              title={signInBusy ? '正在登录云端账户' : '使用当前邮箱和密码登录'}
            >
              {signInBusy && <RefreshCw className="h-4 w-4 animate-spin" />}
              {signInBusy ? '登录中…' : '登录'}
            </button>
            <button
              className="secondary-inline"
              type="button"
              onClick={() => runAuthAction('sign-up', props.onSignUp)}
              disabled={props.busy.auth || props.busy.config || locked}
              aria-label={signUpBusy ? '正在注册云端账户' : '注册'}
              aria-busy={signUpBusy || undefined}
              title={signUpBusy ? '正在注册云端账户' : '使用当前邮箱和密码注册'}
            >
              {signUpBusy && <RefreshCw className="h-4 w-4 animate-spin" />}
              {signUpBusy ? '注册中…' : '注册'}
            </button>
            <button
              className="ghost-inline"
              type="button"
              onClick={() => runAuthAction('sign-out', props.onSignOut)}
              disabled={props.busy.auth || props.busy.config || !props.cloudStatus.authenticated}
              aria-label={signOutBusy ? '正在退出云端账户' : '退出云端账户'}
              aria-busy={signOutBusy || undefined}
              title={signOutBusy ? '正在退出云端账户' : '退出当前云端账户'}
            >
              {signOutBusy ? <RefreshCw className="h-4 w-4 animate-spin" /> : <LogOut className="h-4 w-4" />}
              {signOutBusy ? '退出中…' : '退出'}
            </button>
          </SettingsActionRow>
        </SettingsGroup>
      </SettingsCard>
    </SettingsSection>
  );
}

export default CloudAccountSection;
