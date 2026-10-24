import { beforeEach, describe, expect, it } from 'vitest';
import {
  completedCount,
  deriveOnboardingSteps,
  ONBOARDING_STORAGE_KEY,
  readOnboardingVisibility,
  shouldAutoOpen,
  writeOnboardingVisibility,
  type OnboardingFacts,
} from './onboardingState';

const fresh: OnboardingFacts = {
  totalRecords: 0,
  modelAccessEnabled: false,
  gateway: null,
  cloudAuthenticated: false,
  cloudCapabilityVerified: false,
  cloudFirstSyncCompleted: false,
  routingPublishEnabled: false,
};

const byId = (facts: OnboardingFacts) => Object.fromEntries(deriveOnboardingSteps(facts).map((step) => [step.id, step]));

describe('deriveOnboardingSteps', () => {
  it('全新安装：扫描可做，网关与云端给出第一步，手机等云端', () => {
    const steps = byId(fresh);
    expect(steps.scan).toMatchObject({ status: 'todo', action: 'scan' });
    expect(steps.gateway).toMatchObject({ status: 'todo', action: 'enable-model-access' });
    expect(steps.cloud).toMatchObject({ status: 'todo', action: 'open-cloud-settings' });
    expect(steps.phone).toMatchObject({ status: 'blocked', action: null });
  });

  it('事实没读到时不给动作，也不算完成', () => {
    const steps = byId({ ...fresh, totalRecords: null, modelAccessEnabled: undefined });
    expect(steps.scan).toMatchObject({ status: 'unknown', action: null });
    expect(steps.gateway).toMatchObject({ status: 'unknown', action: null });
    expect(byId({ ...fresh, modelAccessEnabled: true, gateway: null }).gateway.status).toBe('unknown');
  });

  it('网关：开了模型接入但没有启用的供应商时引导去添加', () => {
    const on = (gateway: OnboardingFacts['gateway']) => byId({ ...fresh, modelAccessEnabled: true, gateway }).gateway;
    expect(on({ enabledProviders: 0, running: false, error: null })).toMatchObject({ status: 'todo', action: 'open-providers' });
    expect(on({ enabledProviders: 2, running: true, error: null })).toMatchObject({ status: 'done', action: null });
  });

  it('网关：有启用的供应商但监听没起来（如端口被占）不算完成', () => {
    const step = byId({ ...fresh, modelAccessEnabled: true, gateway: { enabledProviders: 1, running: false, error: '端口 3462 已被占用' } }).gateway;
    expect(step).toMatchObject({ status: 'todo', action: 'open-gateway' });
    expect(step.detail).toContain('端口 3462 已被占用');
  });

  it('云端按登录、检查连接、首次同步逐步推进；完成后手机可开', () => {
    expect(byId({ ...fresh, cloudAuthenticated: true }).cloud.actionLabel).toBe('检查连接');
    expect(byId({ ...fresh, cloudAuthenticated: true, cloudCapabilityVerified: true }).cloud.action).toBe('sync-now');
    const ready = byId({ ...fresh, cloudAuthenticated: true, cloudCapabilityVerified: true, cloudFirstSyncCompleted: true });
    expect(ready.cloud.status).toBe('done');
    expect(ready.phone).toMatchObject({ status: 'todo', action: 'enable-phone-routing' });
  });

  it('手机同步已开就算完成，即使云端状态暂未确认', () => {
    expect(byId({ ...fresh, routingPublishEnabled: true }).phone.status).toBe('done');
  });

  it('全部完成计 4 步', () => {
    const steps = deriveOnboardingSteps({
      totalRecords: 12,
      modelAccessEnabled: true,
      gateway: { enabledProviders: 1, running: true, error: null },
      cloudAuthenticated: true,
      cloudCapabilityVerified: true,
      cloudFirstSyncCompleted: true,
      routingPublishEnabled: true,
    });
    expect(completedCount(steps)).toBe(4);
  });
});

describe('visibility storage', () => {
  beforeEach(() => window.localStorage.clear());

  it('只在从没见过且本机账本为空时自动打开', () => {
    expect(shouldAutoOpen(null, 0)).toBe(true);
    expect(shouldAutoOpen(null, 5)).toBe(false);
    expect(shouldAutoOpen(null, null)).toBe(false);
    expect(shouldAutoOpen('dismissed', 0)).toBe(false);
  });

  it('读写往返，未知值视为没有记录', () => {
    expect(readOnboardingVisibility()).toBeNull();
    writeOnboardingVisibility('minimized');
    expect(readOnboardingVisibility()).toBe('minimized');
    window.localStorage.setItem(ONBOARDING_STORAGE_KEY, 'bogus');
    expect(readOnboardingVisibility()).toBeNull();
  });
});
