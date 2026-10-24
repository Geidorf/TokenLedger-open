/**
 * First-run guide state. The guide only reads facts the app already has
 * (local record count, model access, gateway providers, cloud setup, the
 * phone routing toggle); it never reads subscription credentials.
 */

import { formatCount, getLang, t, type Lang } from '../../i18n';

export type OnboardingStepId = 'scan' | 'gateway' | 'cloud' | 'phone';

/**
 * - `done`: nothing left to do.
 * - `todo`: the step's action is available now.
 * - `blocked`: waits for an earlier step (the phone needs the cloud).
 * - `unknown`: the fact has not loaded yet; no action is offered.
 */
export type OnboardingStepStatus = 'done' | 'todo' | 'blocked' | 'unknown';

export interface OnboardingFacts {
  /** Local ledger rows; null until the database info has been read. */
  totalRecords: number | null;
  /** Model access master switch; undefined until settings are read. */
  modelAccessEnabled: boolean | undefined;
  /**
   * Gateway status; null when unknown or model access is off. A positive
   * provider count alone does not mean the listener started (the port can be
   * taken), so `running` and `error` come along.
   */
  gateway: { enabledProviders: number; running: boolean; error: string | null } | null;
  cloudAuthenticated: boolean;
  cloudCapabilityVerified: boolean;
  cloudFirstSyncCompleted: boolean;
  routingPublishEnabled: boolean;
}

/** What the step's button does; the guide maps each to an app callback. */
export type OnboardingAction =
  | 'scan'
  | 'enable-model-access'
  | 'open-providers'
  | 'open-gateway'
  | 'open-cloud-settings'
  | 'sync-now'
  | 'enable-phone-routing'
  | null;

export interface OnboardingStep {
  id: OnboardingStepId;
  status: OnboardingStepStatus;
  /** One line under the title describing where the step stands. */
  detail: string;
  action: OnboardingAction;
  actionLabel: string;
}

export function cloudReady(facts: OnboardingFacts) {
  return facts.cloudAuthenticated && facts.cloudCapabilityVerified && facts.cloudFirstSyncCompleted;
}

function scanStep(facts: OnboardingFacts, lang: Lang): OnboardingStep {
  if (facts.totalRecords === null) {
    return { id: 'scan', status: 'unknown', detail: t('onboarding.scan.loading', undefined, lang), action: null, actionLabel: '' };
  }
  if (facts.totalRecords > 0) {
    return {
      id: 'scan',
      status: 'done',
      detail: t('onboarding.scan.done', { count: formatCount(facts.totalRecords, lang) }, lang),
      action: null,
      actionLabel: '',
    };
  }
  return {
    id: 'scan',
    status: 'todo',
    detail: t('onboarding.scan.todo', undefined, lang),
    action: 'scan',
    actionLabel: t('onboarding.scan.action', undefined, lang),
  };
}

function gatewayStep(facts: OnboardingFacts, lang: Lang): OnboardingStep {
  if (facts.modelAccessEnabled === undefined) {
    return { id: 'gateway', status: 'unknown', detail: t('onboarding.gateway.loadingSettings', undefined, lang), action: null, actionLabel: '' };
  }
  if (!facts.modelAccessEnabled) {
    return {
      id: 'gateway',
      status: 'todo',
      detail: t('onboarding.gateway.off', undefined, lang),
      action: 'enable-model-access',
      actionLabel: t('onboarding.gateway.offAction', undefined, lang),
    };
  }
  if (facts.gateway === null) {
    return { id: 'gateway', status: 'unknown', detail: t('onboarding.gateway.loadingStatus', undefined, lang), action: null, actionLabel: '' };
  }
  const { enabledProviders, running, error } = facts.gateway;
  if (enabledProviders === 0) {
    return {
      id: 'gateway',
      status: 'todo',
      detail: t('onboarding.gateway.noProvider', undefined, lang),
      action: 'open-providers',
      actionLabel: t('onboarding.gateway.noProviderAction', undefined, lang),
    };
  }
  if (!running) {
    return {
      id: 'gateway',
      status: 'todo',
      detail: error
        ? t('onboarding.gateway.stoppedError', { count: enabledProviders, error }, lang)
        : t('onboarding.gateway.stopped', { count: enabledProviders }, lang),
      action: 'open-gateway',
      actionLabel: t('onboarding.gateway.stoppedAction', undefined, lang),
    };
  }
  return {
    id: 'gateway',
    status: 'done',
    detail: t('onboarding.gateway.running', { count: enabledProviders }, lang),
    action: null,
    actionLabel: '',
  };
}

function cloudStep(facts: OnboardingFacts, lang: Lang): OnboardingStep {
  if (!facts.cloudAuthenticated) {
    return {
      id: 'cloud',
      status: 'todo',
      detail: t('onboarding.cloud.signedOut', undefined, lang),
      action: 'open-cloud-settings',
      actionLabel: t('onboarding.cloud.signedOutAction', undefined, lang),
    };
  }
  if (!facts.cloudCapabilityVerified) {
    return {
      id: 'cloud',
      status: 'todo',
      detail: t('onboarding.cloud.unchecked', undefined, lang),
      action: 'open-cloud-settings',
      actionLabel: t('onboarding.cloud.uncheckedAction', undefined, lang),
    };
  }
  if (!facts.cloudFirstSyncCompleted) {
    return {
      id: 'cloud',
      status: 'todo',
      detail: t('onboarding.cloud.unsynced', undefined, lang),
      action: 'sync-now',
      actionLabel: t('onboarding.cloud.unsyncedAction', undefined, lang),
    };
  }
  return { id: 'cloud', status: 'done', detail: t('onboarding.cloud.done', undefined, lang), action: null, actionLabel: '' };
}

function phoneStep(facts: OnboardingFacts, lang: Lang): OnboardingStep {
  if (facts.routingPublishEnabled) {
    return {
      id: 'phone',
      status: 'done',
      detail: t('onboarding.phone.done', undefined, lang),
      action: null,
      actionLabel: '',
    };
  }
  if (!cloudReady(facts)) {
    return {
      id: 'phone',
      status: 'blocked',
      detail: t('onboarding.phone.blocked', undefined, lang),
      action: null,
      actionLabel: '',
    };
  }
  return {
    id: 'phone',
    status: 'todo',
    detail: t('onboarding.phone.todo', undefined, lang),
    action: 'enable-phone-routing',
    actionLabel: t('onboarding.phone.action', undefined, lang),
  };
}

export function deriveOnboardingSteps(facts: OnboardingFacts, lang: Lang = getLang()): OnboardingStep[] {
  return [scanStep(facts, lang), gatewayStep(facts, lang), cloudStep(facts, lang), phoneStep(facts, lang)];
}

export function completedCount(steps: OnboardingStep[]) {
  return steps.filter((step) => step.status === 'done').length;
}

/**
 * - `open` / `minimized`: the guide is in progress (dialog or corner chip).
 * - `dismissed`: skipped; only reopened from Settings.
 * - `completed`: finished; only reopened from Settings.
 * Absent means the guide has never been shown on this computer.
 */
export type OnboardingVisibility = 'open' | 'minimized' | 'dismissed' | 'completed';

export const ONBOARDING_STORAGE_KEY = 'tokenledger.onboarding.v1';
export const OPEN_ONBOARDING_EVENT = 'tokenledger:open-onboarding';

const VISIBILITIES: readonly OnboardingVisibility[] = ['open', 'minimized', 'dismissed', 'completed'];

export function readOnboardingVisibility(): OnboardingVisibility | null {
  try {
    const value = window.localStorage.getItem(ONBOARDING_STORAGE_KEY);
    return VISIBILITIES.find((item) => item === value) ?? null;
  } catch {
    return null;
  }
}

export function writeOnboardingVisibility(value: OnboardingVisibility) {
  try {
    window.localStorage.setItem(ONBOARDING_STORAGE_KEY, value);
  } catch {
    // Storage can be unavailable (private mode, quota); the guide still works for this session.
  }
}

/**
 * Whether to open the guide on its own: only on a computer that has never
 * seen it and whose local ledger is still empty. Existing users with data
 * are never interrupted; they can open it from Settings.
 */
export function shouldAutoOpen(stored: OnboardingVisibility | null, totalRecords: number | null) {
  return stored === null && totalRecords === 0;
}

/** Asks the mounted guide to open; used by the Settings entry. */
export function requestOpenOnboarding() {
  window.dispatchEvent(new Event(OPEN_ONBOARDING_EVENT));
}
