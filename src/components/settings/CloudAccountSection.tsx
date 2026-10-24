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
import { t, useLang } from '../../i18n';

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
  if (syncBusy) return t('cloud.hint.syncing');
  if (!setup.authenticated) return t('cloud.hint.signIn');
  if (!setup.capabilityVerified) return t('cloud.hint.verify');
  return null;
}

export function firstSyncActionLabel(
  setup: Pick<CloudAccountSectionProps['setup'], 'firstSyncCompleted'>,
  syncBusy: boolean,
): string {
  if (syncBusy) return t('cloud.sync.busyShort');
  return setup.firstSyncCompleted ? t('cloud.sync.latest') : t('cloud.sync.first');
}

export function capabilityActionLabel(
  setup: Pick<CloudAccountSectionProps['setup'], 'capabilityVerified' | 'validating'>,
): string {
  if (setup.validating) return t('cloud.verify.busyShort');
  return setup.capabilityVerified ? t('cloud.verify.again') : t('cloud.verify');
}

export function secureStorageAuthorizationHint(userAgent?: string): string {
  return isMacPlatform(userAgent)
    ? t('cloud.keychain.mac')
    : t('cloud.keychain.other');
}

type AuthAction = 'sign-in' | 'sign-up' | 'sign-out';

export function CloudAccountSection(props: CloudAccountSectionProps) {
  useLang();
  const [keyVisible, setKeyVisible] = useState(false);
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [activeAuthAction, setActiveAuthAction] = useState<AuthAction | null>(null);
  const emailInputRef = useRef<HTMLInputElement>(null);
  const locked = props.cloudStatus.authenticated;
  const firstSyncHint = firstSyncActionHint(props.setup, props.busy.sync);
  const firstSyncHintId = firstSyncHint ? 'cloud-first-sync-hint' : undefined;
  const capabilityBusy = props.setup.validating;
  const capabilityButtonLabel = capabilityBusy ? t('cloud.verify.busy') : capabilityActionLabel(props.setup);
  const capabilityButtonAriaLabel = capabilityBusy ? t('cloud.verify.busyAria') : capabilityActionLabel(props.setup);
  const statusKnown = props.statusKnown !== false;
  const statusChecking = props.statusChecking ?? false;
  const statusError = props.statusError || '';
  const statusErrorId = statusError ? 'cloud-status-gate-error' : undefined;
  const firstSyncButtonAriaLabel = props.busy.sync
    ? t('cloud.sync.busyAria')
    : props.setup.firstSyncCompleted ? t('cloud.sync.latest') : t('cloud.sync.first');
  const quickSyncButtonLabel = props.busy.sync ? t('cloud.sync.busy') : t('cloud.sync.now');
  const quickSyncButtonAriaLabel = props.busy.sync ? t('cloud.sync.busyAria') : t('cloud.sync.nowAria');
  const configButtonLabel = props.busy.config ? t('cloud.config.saving') : t('cloud.config.save');
  const configButtonAriaLabel = props.busy.config ? t('cloud.config.savingAria') : t('cloud.step.config');
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
    { label: t('cloud.step.config'), done: props.setup.configured, note: t('cloud.step.configNote') },
    { label: t('cloud.step.signIn'), done: props.setup.authenticated, note: t('cloud.step.signInNote') },
    { label: t('cloud.verify'), done: props.setup.capabilityVerified, note: t('cloud.step.verifyNote') },
    { label: t('cloud.step.firstSync'), done: props.setup.firstSyncCompleted, note: t('cloud.step.firstSyncNote') },
  ];

  return (
    <SettingsSection id="cloud" title={t('cloud.title')}>
      <SettingsCard title={t('cloud.progress')}>
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
                <strong>{statusError ? t('cloud.status.unread') : t('cloud.status.unchecked')}</strong>
                <p id={statusErrorId}>{statusError || t('cloud.status.note')}</p>
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
              aria-label={statusChecking ? t('cloud.status.checkingAria') : statusError ? t('cloud.status.retryAria') : t('cloud.status.checkAria')}
              aria-describedby={statusErrorId}
              aria-busy={statusChecking || undefined}
              title={statusChecking ? t('cloud.status.readingTitle') : t('cloud.status.checkTitle')}
            >
              {statusChecking && <RefreshCw className="h-4 w-4 animate-spin" />}
              {statusChecking ? t('cloud.status.checking') : statusError ? t('cloud.status.retry') : t('cloud.status.check')}
            </button>
          </div>
        )}
        {statusKnown && (
          <>
            <ol className="cloud-setup-steps" aria-label={t('cloud.steps.aria')}>
              {steps.map((step, index) => (
                <li className={step.done ? 'is-complete' : ''} key={step.label}>
                  {step.done
                    ? <CheckCircle2 className="h-5 w-5" aria-hidden="true" />
                    : <Circle className="h-5 w-5" aria-hidden="true" />}
                  <span>
                    <strong>{index + 1}. {step.label}</strong>
                    <small>{step.note}</small>
                  </span>
                  <em>{step.done ? t('cloud.step.done') : t('cloud.step.todo')}</em>
                </li>
              ))}
            </ol>
            <SettingsActionRow busy={capabilityBusy || props.busy.sync}>
              {firstSyncHint && <span className="settings-action-note" id={firstSyncHintId}>{firstSyncHint}</span>}
              {!props.setup.authenticated && (
                <button className="primary-inline" type="button" onClick={focusLoginField}>
                  {t('cloud.signInCloud')}
                </button>
              )}
              <button
                className="secondary-inline"
                type="button"
                onClick={props.onValidateCapability}
                disabled={!props.setup.authenticated || capabilityBusy || props.busy.sync}
                aria-label={capabilityButtonAriaLabel}
                aria-busy={capabilityBusy || undefined}
                title={capabilityBusy ? capabilityButtonAriaLabel : t('cloud.verify.title')}
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
                title={props.busy.sync ? firstSyncButtonAriaLabel : t('cloud.sync.title')}
              >
                <RefreshCw className={`h-4 w-4 ${props.busy.sync ? 'animate-spin' : ''}`} />
                {firstSyncActionLabel(props.setup, props.busy.sync)}
              </button>
            </SettingsActionRow>
          </>
        )}
        {props.setup.lastError && <p className="form-error cloud-setup-error" role="alert">{props.setup.lastError}</p>}
      </SettingsCard>

      <SettingsCard title={t('cloud.config.card')}>
        <form onSubmit={props.onSaveConfig}>
          <SettingsGroup>
            <SettingsRow label="Supabase URL" hint={t('cloud.url.hint')} icon={Cloud}>
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
            <SettingsRow label="Publishable Key" hint={t('cloud.key.hint')} icon={KeyRound}>
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
                aria-label={keyVisible ? t('cloud.key.hide') : t('cloud.key.show')}
                aria-pressed={keyVisible}
                onClick={() => setKeyVisible((visible) => !visible)}
              >
                {keyVisible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </SettingsRow>
            {locked && (
              <SettingsRow label={t('cloud.config.edit')} hint={t('cloud.config.editHint')} icon={ShieldCheck}>
                <span className="settings-value">{t('cloud.config.locked')}</span>
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
                title={props.busy.config ? configButtonAriaLabel : t('cloud.config.title')}
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
                title={props.busy.sync ? quickSyncButtonAriaLabel : t('cloud.sync.nowTitle')}
              >
                <RefreshCw className={`h-4 w-4 ${props.busy.sync ? 'animate-spin' : ''}`} />
                {quickSyncButtonLabel}
              </button>
            </SettingsActionRow>
          </SettingsGroup>
        </form>
      </SettingsCard>

      <SettingsCard title={t('cloud.account')}>
        <SettingsGroup>
          <SettingsRow label={t('cloud.configStatus')} icon={ShieldCheck}>
            <span className="settings-value">{props.cloudStatus.configured ? t('cloud.configured') : t('cloud.notConfigured')}</span>
          </SettingsRow>
          <SettingsRow label={t('cloud.signInStatus')} hint={t('cloud.signInStatusHint')} icon={Cloud}>
            <span className="settings-value">
              {props.cloudStatus.authenticated ? props.cloudStatus.email || t('cloud.signedIn') : t('cloud.signedOut')}
            </span>
          </SettingsRow>
          <SettingsRow label={t('cloud.email')} icon={Mail}>
            <input
              ref={emailInputRef}
              className="settings-input"
              type="email"
              value={props.authForm.email}
              disabled={locked}
              autoComplete="username"
              aria-label={t('cloud.email')}
              aria-invalid={!!props.authError}
              aria-describedby={props.authError ? 'cloud-auth-error' : undefined}
              onChange={(event) => props.onAuthFormChange({ ...props.authForm, email: event.target.value })}
            />
          </SettingsRow>
          <SettingsRow label={t('cloud.password')} icon={KeyRound}>
            <input
              className="settings-input"
              type={passwordVisible ? 'text' : 'password'}
              value={props.authForm.password}
              disabled={locked}
              autoComplete="current-password"
              aria-label={t('cloud.password')}
              aria-invalid={!!props.authError}
              aria-describedby={props.authError ? 'cloud-auth-error' : undefined}
              onChange={(event) => props.onAuthFormChange({ ...props.authForm, password: event.target.value })}
            />
            <button
              className="settings-input-affix"
              type="button"
              aria-label={passwordVisible ? t('cloud.password.hide') : t('cloud.password.show')}
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
              aria-label={signInBusy ? t('cloud.signIn.busyAria') : t('cloud.signIn')}
              aria-busy={signInBusy || undefined}
              title={signInBusy ? t('cloud.signIn.busyAria') : t('cloud.signIn.title')}
            >
              {signInBusy && <RefreshCw className="h-4 w-4 animate-spin" />}
              {signInBusy ? t('cloud.signIn.busy') : t('cloud.signIn')}
            </button>
            <button
              className="secondary-inline"
              type="button"
              onClick={() => runAuthAction('sign-up', props.onSignUp)}
              disabled={props.busy.auth || props.busy.config || locked}
              aria-label={signUpBusy ? t('cloud.signUp.busyAria') : t('cloud.signUp')}
              aria-busy={signUpBusy || undefined}
              title={signUpBusy ? t('cloud.signUp.busyAria') : t('cloud.signUp.title')}
            >
              {signUpBusy && <RefreshCw className="h-4 w-4 animate-spin" />}
              {signUpBusy ? t('cloud.signUp.busy') : t('cloud.signUp')}
            </button>
            <button
              className="ghost-inline"
              type="button"
              onClick={() => runAuthAction('sign-out', props.onSignOut)}
              disabled={props.busy.auth || props.busy.config || !props.cloudStatus.authenticated}
              aria-label={signOutBusy ? t('cloud.signOut.busyAria') : t('cloud.signOut.aria')}
              aria-busy={signOutBusy || undefined}
              title={signOutBusy ? t('cloud.signOut.busyAria') : t('cloud.signOut.title')}
            >
              {signOutBusy ? <RefreshCw className="h-4 w-4 animate-spin" /> : <LogOut className="h-4 w-4" />}
              {signOutBusy ? t('cloud.signOut.busy') : t('cloud.signOut')}
            </button>
          </SettingsActionRow>
        </SettingsGroup>
      </SettingsCard>
    </SettingsSection>
  );
}

export default CloudAccountSection;
