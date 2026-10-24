import { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, ShieldCheck } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { t, useLang } from '../../i18n';

interface SettingsSectionProps {
  id: string;
  title: string;
  children: React.ReactNode;
}

/**
 * A settings section is only the anchor target + heading. Each section composes
 * its own cards/groups so we can mix rows, info cards, disclosures and danger
 * zones without forcing everything through one row container.
 */
export function SettingsSection({ id, title, children }: SettingsSectionProps) {
  const titleId = `settings-${id}-title`;
  return (
    <section className="settings-section" id={`settings-${id}`} tabIndex={-1} aria-labelledby={titleId}>
      <h2 className="settings-section-title" id={titleId}>{title}</h2>
      {children}
    </section>
  );
}

export function SettingsGroup({ children }: { children: React.ReactNode }) {
  return <div className="settings-group">{children}</div>;
}

/**
 * `description` 用于卡片标题不足以说清"这张卡管的是什么东西"的场合——例如桌面端
 * 两块挂件（托盘挂件 / 桌面小组件）光靠标题分不清，逐条开关的 hint 又只能解释
 * 单个开关的行为。省略时卡片外观与以前完全一致。
 */
export function SettingsCard({ title, description, children }: { title?: string; description?: string; children: React.ReactNode }) {
  return (
    <div className="settings-card">
      {title && <h3 className="settings-card-title">{title}</h3>}
      {description && <p className="settings-card-description">{description}</p>}
      {children}
    </div>
  );
}

interface SettingsRowProps {
  label: string;
  hint?: string;
  hintId?: string;
  icon?: LucideIcon;
  children: React.ReactNode;
  danger?: boolean;
  wideControl?: boolean;
  busy?: boolean;
}

export function SettingsRow({ label, hint, hintId, icon: Icon, children, danger, wideControl, busy: rowBusy }: SettingsRowProps) {
  return (
    <div
      className={`settings-row ${danger ? 'settings-row-danger' : ''} ${wideControl ? 'settings-row-wide-control' : ''}`}
      aria-busy={rowBusy || undefined}
    >
      <div className="settings-row-main">
        {Icon && (
          <span className="settings-row-icon">
            <Icon className="h-3.5 w-3.5" />
          </span>
        )}
        <div className="min-w-0">
          <div className="settings-row-label">{label}</div>
          {hint && <div className="settings-row-hint" id={hintId}>{hint}</div>}
        </div>
      </div>
      <div className="settings-row-control">{children}</div>
    </div>
  );
}

interface SettingsToggleRowProps {
  label: string;
  hint?: string;
  icon: LucideIcon;
  checked: boolean;
  disabled?: boolean;
  busy?: boolean;
  onChange: (checked: boolean) => void;
}

export function SettingsToggleRow({ label, hint, icon, checked, disabled, busy = false, onChange }: SettingsToggleRowProps) {
  useLang();
  const hintId = useId();
  const actionLabel = busy ? t('settings.toggle.savingAria', { label }) : label;
  return (
    <SettingsRow label={label} hint={hint} hintId={hint ? hintId : undefined} icon={icon} busy={busy}>
      <div className="settings-toggle-control">
        <button
          className={`sf-switch${busy ? ' is-busy' : ''}`}
          type="button"
          role="switch"
          aria-label={actionLabel}
          aria-describedby={hint ? hintId : undefined}
          aria-checked={checked}
          aria-busy={busy || undefined}
          title={busy ? t('settings.toggle.savingTitle', { label }) : undefined}
          disabled={disabled}
          onClick={() => onChange(!checked)}
        />
        {busy && <span className="settings-toggle-feedback" role="status" aria-live="polite">{t('settings.toggle.saving')}</span>}
      </div>
    </SettingsRow>
  );
}

export function SettingsActionRow({ children, busy }: { children: React.ReactNode; busy?: boolean }) {
  return <div className="settings-action-row" aria-busy={busy || undefined}>{children}</div>;
}

interface InfoStatRowProps {
  label: string;
  value: React.ReactNode;
  hint?: string;
  icon?: LucideIcon;
}

/**
 * Read-only statistics presented as an information card. Deliberately not a
 * button and exposes no control affordance so assistive tech and pointer users
 * both read it as static data.
 */
export function InfoStatRow({ label, value, hint, icon: Icon }: InfoStatRowProps) {
  return (
    <div className="settings-info-card">
      {Icon && (
        <span className="settings-info-icon">
          <Icon className="h-3.5 w-3.5" />
        </span>
      )}
      <div className="settings-info-body">
        <div className="settings-info-label">{label}</div>
        <div className="settings-info-value">{value}</div>
        {hint && <div className="settings-info-hint">{hint}</div>}
      </div>
    </div>
  );
}

interface DisclosurePanelProps {
  title?: string;
  ariaLabel?: string;
  children: React.ReactNode;
  /**
   * When this number changes the panel expands itself once. Used to auto-reveal
   * the boundary text the first time the matching switch is turned on.
   */
  openSignal?: number;
  decorative?: boolean;
}

export function DisclosurePanel({ title = t('settings.disclosure.default'), ariaLabel, children, openSignal, decorative }: DisclosurePanelProps) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const lastSignal = useRef(openSignal);
  useEffect(() => {
    if (openSignal !== undefined && openSignal !== lastSignal.current) {
      lastSignal.current = openSignal;
      setOpen(true);
    }
  }, [openSignal]);
  return (
    <div className="settings-disclosure">
      <button
        className="settings-disclosure-trigger"
        type="button"
        aria-expanded={open}
        aria-controls={open ? bodyId : undefined}
        aria-label={ariaLabel ?? title}
        onClick={() => setOpen((value) => !value)}
      >
        {!decorative && <ShieldCheck className="settings-disclosure-lead h-3.5 w-3.5" />}
        <span className="settings-disclosure-title">{title}</span>
        <ChevronDown className={`settings-disclosure-caret ${open ? 'is-expanded' : ''}`} />
      </button>
      {open && (
        <div className="settings-disclosure-body" id={bodyId}>
          {children}
        </div>
      )}
    </div>
  );
}

export function DangerZone({ title = t('settings.danger.default'), children }: { title?: string; children: React.ReactNode }) {
  return (
    <div className="settings-danger-zone">
      <div className="settings-danger-zone-title">{title}</div>
      {children}
    </div>
  );
}

/**
 * Emit a monotonically increasing signal the moment `enabled` transitions from
 * false to true, so a card can auto-expand its boundary disclosure exactly once
 * per enable without re-opening on every unrelated re-render.
 */
export function useFirstEnableSignal(enabled: boolean): number {
  const [signal, setSignal] = useState(0);
  const previous = useRef(enabled);
  useEffect(() => {
    if (enabled && !previous.current) setSignal((value) => value + 1);
    previous.current = enabled;
  }, [enabled]);
  return signal;
}
