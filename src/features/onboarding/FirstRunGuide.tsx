import { Check, Cloud, FolderSearch, Lock, Network, Smartphone, Sparkles, X, type LucideIcon } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AppSettings } from '../../types';
import { focusWrapTarget } from '../../utils/frontendContracts';
import { errorText, gatewayStatus, setModelAccess } from '../gateway/api';
import {
  completedCount,
  deriveOnboardingSteps,
  OPEN_ONBOARDING_EVENT,
  readOnboardingVisibility,
  shouldAutoOpen,
  writeOnboardingVisibility,
  type OnboardingAction,
  type OnboardingFacts,
  type OnboardingStep,
  type OnboardingStepId,
  type OnboardingVisibility,
} from './onboardingState';

const STEP_COPY: Record<OnboardingStepId, { title: string; icon: LucideIcon; optional: boolean }> = {
  scan: { title: '扫描本机数据', icon: FolderSearch, optional: false },
  gateway: { title: '开启模型网关', icon: Network, optional: true },
  cloud: { title: '开启云端同步', icon: Cloud, optional: true },
  phone: { title: '手机锁屏壁纸', icon: Smartphone, optional: true },
};

const GATEWAY_POLL_MS = 5_000;

export interface FirstRunGuideProps {
  facts: Omit<OnboardingFacts, 'enabledProviders'>;
  scanBusy: boolean;
  syncBusy: boolean;
  settingsBusy: boolean;
  /** Bumped by the app when gateway providers change. */
  gatewayRefreshKey: number;
  onScan: () => void;
  onSync: () => void;
  onModelAccessChanged: (settings: AppSettings) => void;
  onEnablePhoneRouting: () => void;
  onOpenProviders: () => void;
  onOpenCloudSettings: () => void;
  onNotify: (message: string) => void;
}

type View = 'hidden' | 'open' | 'minimized';

function viewFor(stored: OnboardingVisibility | null): View {
  return stored === 'open' ? 'open' : stored === 'minimized' ? 'minimized' : 'hidden';
}

/**
 * First-run guide: a dialog listing the four setup steps with their live
 * state, which folds into a corner chip while the user follows a step
 * elsewhere in the app. Opens by itself only on a computer with an empty
 * local ledger that has never seen it; Settings can reopen it any time.
 */
export function FirstRunGuide(props: FirstRunGuideProps) {
  const { facts, gatewayRefreshKey, onNotify } = props;
  const [view, setView] = useState<View>(() => viewFor(readOnboardingVisibility()));
  const [enabledProviders, setEnabledProviders] = useState<number | null>(null);
  const [accessBusy, setAccessBusy] = useState(false);

  const show = useCallback((next: View, persist: OnboardingVisibility | null) => {
    setView(next);
    if (persist) writeOnboardingVisibility(persist);
  }, []);

  // Auto-open once, when the ledger turns out to be empty on a computer that never saw the guide.
  useEffect(() => {
    if (shouldAutoOpen(readOnboardingVisibility(), facts.totalRecords)) show('open', 'open');
  }, [facts.totalRecords, show]);

  useEffect(() => {
    const open = () => show('open', 'open');
    window.addEventListener(OPEN_ONBOARDING_EVENT, open);
    return () => window.removeEventListener(OPEN_ONBOARDING_EVENT, open);
  }, [show]);

  // Gateway providers are only read while the guide is visible and model access is on.
  const watchGateway = view !== 'hidden' && facts.modelAccessEnabled === true;
  useEffect(() => {
    if (!watchGateway) {
      setEnabledProviders(null);
      return undefined;
    }
    let cancelled = false;
    const read = () => {
      gatewayStatus()
        .then((status) => { if (!cancelled) setEnabledProviders(status.enabledCount); })
        .catch(() => { if (!cancelled) setEnabledProviders(null); });
    };
    read();
    const timer = window.setInterval(read, GATEWAY_POLL_MS);
    window.addEventListener('focus', read);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener('focus', read);
    };
  }, [watchGateway, gatewayRefreshKey]);

  const steps = useMemo(
    () => deriveOnboardingSteps({ ...facts, enabledProviders }),
    [facts, enabledProviders],
  );
  const done = completedCount(steps);
  const allDone = done === steps.length;

  const minimize = useCallback(() => show('minimized', 'minimized'), [show]);
  const dismiss = useCallback(() => show('hidden', allDone ? 'completed' : 'dismissed'), [allDone, show]);

  const runAction = (action: OnboardingAction) => {
    switch (action) {
      case 'scan':
        props.onScan();
        return;
      case 'sync-now':
        props.onSync();
        return;
      case 'enable-phone-routing':
        props.onEnablePhoneRouting();
        return;
      case 'enable-model-access':
        setAccessBusy(true);
        setModelAccess(true)
          .then(props.onModelAccessChanged)
          .catch((error) => onNotify(errorText(error)))
          .finally(() => setAccessBusy(false));
        return;
      case 'open-providers':
        minimize();
        props.onOpenProviders();
        return;
      case 'open-cloud-settings':
        minimize();
        props.onOpenCloudSettings();
        return;
      default:
    }
  };

  const actionBusy = (action: OnboardingAction) => (
    (action === 'scan' && props.scanBusy)
    || (action === 'sync-now' && props.syncBusy)
    || (action === 'enable-model-access' && accessBusy)
    || (action === 'enable-phone-routing' && props.settingsBusy)
  );

  if (view === 'hidden') return null;
  if (view === 'minimized') {
    return (
      <GuideChip
        done={done}
        total={steps.length}
        onOpen={() => show('open', 'open')}
        onDismiss={dismiss}
      />
    );
  }
  return (
    <GuideDialog
      steps={steps}
      done={done}
      allDone={allDone}
      actionBusy={actionBusy}
      onAction={runAction}
      onMinimize={minimize}
      onDismiss={dismiss}
    />
  );
}

function GuideChip({ done, total, onOpen, onDismiss }: { done: number; total: number; onOpen: () => void; onDismiss: () => void }) {
  const allDone = done === total;
  return (
    <div className="onboarding-chip" role="region" aria-label="新手引导">
      <button type="button" className="onboarding-chip-open" onClick={onOpen} aria-label={`${allDone ? '设置完成' : '开始使用'}：已完成 ${done}/${total} 步，展开新手引导`}>
        <ProgressRing done={done} total={total} />
        <span>{allDone ? '设置完成' : '开始使用'}</span>
        <span className="onboarding-chip-count">{done}/{total}</span>
      </button>
      <button type="button" className="onboarding-chip-close" onClick={onDismiss} aria-label={allDone ? '关闭新手引导' : '不再提示新手引导'} title={allDone ? '关闭' : '不再提示（可在设置 › 数据与帮助里重新打开）'}>
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function ProgressRing({ done, total }: { done: number; total: number }) {
  const r = 7;
  const c = 2 * Math.PI * r;
  return (
    <svg className="onboarding-ring" viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
      <circle cx="9" cy="9" r={r} className="onboarding-ring-track" />
      <circle cx="9" cy="9" r={r} className="onboarding-ring-fill" strokeDasharray={`${(c * done) / total} ${c}`} transform="rotate(-90 9 9)" />
    </svg>
  );
}

function GuideDialog({ steps, done, allDone, actionBusy, onAction, onMinimize, onDismiss }: {
  steps: OnboardingStep[];
  done: number;
  allDone: boolean;
  actionBusy: (action: OnboardingAction) => boolean;
  onAction: (action: OnboardingAction) => void;
  onMinimize: () => void;
  onDismiss: () => void;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const onMinimizeRef = useRef(onMinimize);
  useEffect(() => { onMinimizeRef.current = onMinimize; }, [onMinimize]);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    const frame = window.requestAnimationFrame(() => {
      const target = dialog?.querySelector<HTMLElement>('.onboarding-step.is-current .primary-inline, .onboarding-footer .primary-inline');
      (target ?? dialog)?.focus();
    });
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onMinimizeRef.current();
        return;
      }
      if (event.key !== 'Tab' || !dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>('button:not([disabled])'));
      if (focusable.length === 0) return;
      const wrap = focusWrapTarget(
        event.shiftKey ? 'backward' : 'forward',
        document.activeElement === focusable[0],
        document.activeElement === focusable[focusable.length - 1],
      );
      if (wrap === 'last') {
        event.preventDefault();
        focusable[focusable.length - 1].focus();
      } else if (wrap === 'first') {
        event.preventDefault();
        focusable[0].focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener('keydown', handleKeyDown);
      previous?.focus({ preventScroll: true });
    };
  }, []);

  const currentId = steps.find((step) => step.status === 'todo')?.id;
  const dialog = (
    <div className="modal-overlay onboarding-overlay" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) onMinimize(); }}>
      <section
        ref={dialogRef}
        className="modal-content onboarding-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="onboarding-title"
        aria-describedby="onboarding-subtitle"
        tabIndex={-1}
      >
        <header className="onboarding-head">
          <span className="onboarding-mark" aria-hidden="true"><Sparkles className="h-5 w-5" /></span>
          <div className="onboarding-head-copy">
            <h2 id="onboarding-title">{allDone ? '一切就绪' : '欢迎使用 TokenLedger'}</h2>
            <p id="onboarding-subtitle">
              {allDone
                ? '四步都完成了。之后可在「设置 › 数据与帮助」重新打开这份引导。'
                : '第一步扫描本机数据就能看到用量；后面三步按需开启，随时可以跳过。'}
            </p>
          </div>
          <button type="button" className="onboarding-icon-button" onClick={onMinimize} aria-label="收起新手引导" title="收起到右下角">
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="onboarding-progress" aria-label={`已完成 ${done} / ${steps.length} 步`}>
          {steps.map((step) => <span key={step.id} className={step.status === 'done' ? 'is-done' : ''} />)}
        </div>

        <ol className="onboarding-steps">
          {steps.map((step, index) => (
            <StepRow
              key={step.id}
              step={step}
              index={index}
              current={step.id === currentId}
              busy={actionBusy(step.action)}
              onAction={() => onAction(step.action)}
            />
          ))}
        </ol>

        <footer className="onboarding-footer">
          <span className="onboarding-privacy"><Lock className="h-3.5 w-3.5" aria-hidden="true" />数据默认只留在本机；不读取任何订阅账号的登录凭据。</span>
          {allDone
            ? <button type="button" className="primary-inline" onClick={onDismiss}>开始使用</button>
            : <button type="button" className="ghost-inline" onClick={onDismiss}>跳过引导</button>}
        </footer>
      </section>
    </div>
  );
  return typeof document !== 'undefined' ? createPortal(dialog, document.body) : dialog;
}

function StepRow({ step, index, current, busy, onAction }: {
  step: OnboardingStep;
  index: number;
  current: boolean;
  busy: boolean;
  onAction: () => void;
}) {
  const copy = STEP_COPY[step.id];
  const Icon = copy.icon;
  const titleId = `onboarding-step-${step.id}`;
  return (
    <li className={`onboarding-step is-${step.status}${current ? ' is-current' : ''}`} aria-labelledby={titleId}>
      <span className="onboarding-step-badge" aria-hidden="true">
        {step.status === 'done' ? <Check className="h-4 w-4" /> : <Icon className="h-4 w-4" />}
      </span>
      <div className="onboarding-step-copy">
        <strong id={titleId}>
          <span className="onboarding-step-index">{index + 1}</span>
          {copy.title}
          {copy.optional && step.status !== 'done' && <span className="onboarding-tag">可选</span>}
          {step.status === 'done' && <span className="onboarding-tag is-done">已完成</span>}
        </strong>
        <p>{step.detail}</p>
      </div>
      {step.action && (
        <button
          type="button"
          className={current ? 'primary-inline' : 'secondary-inline'}
          onClick={onAction}
          disabled={busy}
          aria-busy={busy || undefined}
          aria-describedby={titleId}
        >
          {busy ? '处理中…' : step.actionLabel}
        </button>
      )}
    </li>
  );
}
