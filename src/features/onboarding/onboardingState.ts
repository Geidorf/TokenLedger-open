/**
 * First-run guide state. The guide only reads facts the app already has
 * (local record count, model access, gateway providers, cloud setup, the
 * phone routing toggle); it never reads subscription credentials.
 */

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

function scanStep(facts: OnboardingFacts): OnboardingStep {
  if (facts.totalRecords === null) {
    return { id: 'scan', status: 'unknown', detail: '正在读取本机数据库…', action: null, actionLabel: '' };
  }
  if (facts.totalRecords > 0) {
    return {
      id: 'scan',
      status: 'done',
      detail: `已读到 ${facts.totalRecords.toLocaleString('zh-CN')} 条记录，概览页已经有数据了。`,
      action: null,
      actionLabel: '',
    };
  }
  return {
    id: 'scan',
    status: 'todo',
    detail: '读取 Claude Code、Codex 等工具留在本机的日志，只在本机计算，不上传。',
    action: 'scan',
    actionLabel: '扫描本机日志',
  };
}

function gatewayStep(facts: OnboardingFacts): OnboardingStep {
  if (facts.modelAccessEnabled === undefined) {
    return { id: 'gateway', status: 'unknown', detail: '正在读取设置…', action: null, actionLabel: '' };
  }
  if (!facts.modelAccessEnabled) {
    return {
      id: 'gateway',
      status: 'todo',
      detail: '在本机起一个统一入口，Agent 经它转发就能自动记账、按规则路由、失败自动切换。',
      action: 'enable-model-access',
      actionLabel: '开启模型接入',
    };
  }
  if (facts.gateway === null) {
    return { id: 'gateway', status: 'unknown', detail: '正在读取网关状态…', action: null, actionLabel: '' };
  }
  const { enabledProviders, running, error } = facts.gateway;
  if (enabledProviders === 0) {
    return {
      id: 'gateway',
      status: 'todo',
      detail: '模型接入已开启。添加一个供应商并填入 API key，网关就会自动启动。',
      action: 'open-providers',
      actionLabel: '添加供应商',
    };
  }
  if (!running) {
    return {
      id: 'gateway',
      status: 'todo',
      detail: `已启用 ${enabledProviders} 个供应商，但网关没有启动${error ? `：${error}` : '。'}`,
      action: 'open-gateway',
      actionLabel: '查看网关',
    };
  }
  return {
    id: 'gateway',
    status: 'done',
    detail: `网关运行中，${enabledProviders} 个供应商已启用。`,
    action: null,
    actionLabel: '',
  };
}

function cloudStep(facts: OnboardingFacts): OnboardingStep {
  if (!facts.cloudAuthenticated) {
    return {
      id: 'cloud',
      status: 'todo',
      detail: '登录账户后，多台电脑的用量汇总到一起，手机也能看。',
      action: 'open-cloud-settings',
      actionLabel: '登录账户',
    };
  }
  if (!facts.cloudCapabilityVerified) {
    return {
      id: 'cloud',
      status: 'todo',
      detail: '已登录，还需要检查一次数据连接。',
      action: 'open-cloud-settings',
      actionLabel: '检查连接',
    };
  }
  if (!facts.cloudFirstSyncCompleted) {
    return {
      id: 'cloud',
      status: 'todo',
      detail: '连接正常。完成首次同步后，云端汇总和手机端才会有数据。',
      action: 'sync-now',
      actionLabel: '立即同步',
    };
  }
  return { id: 'cloud', status: 'done', detail: '已登录并完成首次同步。', action: null, actionLabel: '' };
}

function phoneStep(facts: OnboardingFacts): OnboardingStep {
  if (facts.routingPublishEnabled) {
    return {
      id: 'phone',
      status: 'done',
      detail: '已开启。手机登录同一账户，在「我的」里设为动态壁纸即可。',
      action: null,
      actionLabel: '',
    };
  }
  if (!cloudReady(facts)) {
    return {
      id: 'phone',
      status: 'blocked',
      detail: '手机经云端读取路由，先完成上一步的云端同步。',
      action: null,
      actionLabel: '',
    };
  }
  return {
    id: 'phone',
    status: 'todo',
    detail: '把实时路由同步到手机，Android 锁屏显示网关路由动画。只上传 Agent 名、供应商/模型和状态码。',
    action: 'enable-phone-routing',
    actionLabel: '开启同步到手机',
  };
}

export function deriveOnboardingSteps(facts: OnboardingFacts): OnboardingStep[] {
  return [scanStep(facts), gatewayStep(facts), cloudStep(facts), phoneStep(facts)];
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
