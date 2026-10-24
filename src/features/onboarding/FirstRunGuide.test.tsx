import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getLang, LANG_STORAGE_KEY, setLangPreference } from '../../i18n';
import * as api from '../gateway/api';
import { FirstRunGuide, type FirstRunGuideProps } from './FirstRunGuide';
import { ONBOARDING_STORAGE_KEY, requestOpenOnboarding } from './onboardingState';

vi.mock('../gateway/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../gateway/api')>();
  return { ...actual, gatewayStatus: vi.fn(), setModelAccess: vi.fn() };
});

function renderGuide(overrides: Partial<FirstRunGuideProps> = {}, facts: Partial<FirstRunGuideProps['facts']> = {}) {
  const props: FirstRunGuideProps = {
    facts: {
      totalRecords: 0,
      modelAccessEnabled: false,
      cloudAuthenticated: false,
      cloudCapabilityVerified: false,
      cloudFirstSyncCompleted: false,
      routingPublishEnabled: false,
      ...facts,
    },
    latestError: '',
    scanBusy: false,
    syncBusy: false,
    settingsBusy: false,
    gatewayRefreshKey: 0,
    onScan: vi.fn(),
    onSync: vi.fn(),
    onModelAccessChanged: vi.fn(),
    onEnablePhoneRouting: vi.fn(),
    onOpenProviders: vi.fn(),
    onOpenGateway: vi.fn(),
    onOpenCloudSettings: vi.fn(),
    onNotify: vi.fn(),
    ...overrides,
  };
  return { props, ...render(<FirstRunGuide {...props} />) };
}

describe('FirstRunGuide', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.clearAllMocks();
    vi.mocked(api.gatewayStatus).mockResolvedValue({ running: false, port: 3462, providerCount: 0, enabledCount: 0 });
  });

  afterEach(() => {
    act(() => setLangPreference('zh'));
  });

  it('本机账本为空的新电脑自动打开，第一步可直接扫描', () => {
    const { props } = renderGuide();
    expect(screen.getByRole('dialog', { name: '欢迎使用 TokenLedger' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '扫描本机日志' }));
    expect(props.onScan).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(ONBOARDING_STORAGE_KEY)).toBe('open');
  });

  it('已有数据的电脑不打扰，设置页可以重新打开', () => {
    renderGuide({}, { totalRecords: 120 });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    act(() => requestOpenOnboarding());
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText(/已读到 120 条记录/)).toBeInTheDocument();
  });

  it('去别的页面做某一步时收起成右下角进度，点开回到清单', () => {
    const { props } = renderGuide();
    fireEvent.click(screen.getByRole('button', { name: '登录账户' }));
    expect(props.onOpenCloudSettings).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(window.localStorage.getItem(ONBOARDING_STORAGE_KEY)).toBe('minimized');
    fireEvent.click(screen.getByRole('button', { name: /开始使用：已完成 0\/4 步/ }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('Esc 收起而不是关掉；跳过后不再自动出现', () => {
    renderGuide();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByRole('region', { name: '新手引导' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '不再提示新手引导' }));
    expect(screen.queryByRole('region', { name: '新手引导' })).not.toBeInTheDocument();
    expect(window.localStorage.getItem(ONBOARDING_STORAGE_KEY)).toBe('dismissed');
  });

  it('开启模型接入后读网关状态，没有供应商时引导去添加', async () => {
    vi.mocked(api.setModelAccess).mockResolvedValue({ model_access_enabled: true } as never);
    const { props, rerender } = renderGuide({}, { totalRecords: 3 });
    act(() => requestOpenOnboarding());
    fireEvent.click(screen.getByRole('button', { name: '开启模型接入' }));
    await waitFor(() => expect(props.onModelAccessChanged).toHaveBeenCalled());
    rerender(<FirstRunGuide {...props} facts={{ ...props.facts, modelAccessEnabled: true }} />);
    fireEvent.click(await screen.findByRole('button', { name: '添加供应商' }));
    expect(props.onOpenProviders).toHaveBeenCalledTimes(1);
  });

  it('手机壁纸要等云端同步完成才给按钮', () => {
    const { props, rerender } = renderGuide({}, { totalRecords: 3 });
    act(() => requestOpenOnboarding());
    expect(screen.getByText(/先完成上一步的云端同步/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '开启同步到手机' })).not.toBeInTheDocument();
    rerender(<FirstRunGuide {...props} facts={{ ...props.facts, cloudAuthenticated: true, cloudCapabilityVerified: true, cloudFirstSyncCompleted: true }} />);
    fireEvent.click(screen.getByRole('button', { name: '开启同步到手机' }));
    expect(props.onEnablePhoneRouting).toHaveBeenCalledTimes(1);
  });

  it('网关没起来时引导去网关页，App 的报错在引导里也看得到', async () => {
    vi.mocked(api.gatewayStatus).mockResolvedValue({ running: false, port: 3462, providerCount: 1, enabledCount: 1, error: '端口 3462 已被占用' });
    const { props, rerender } = renderGuide({}, { totalRecords: 3, modelAccessEnabled: true });
    act(() => requestOpenOnboarding());
    expect(await screen.findByText(/端口 3462 已被占用/)).toBeInTheDocument();
    rerender(<FirstRunGuide {...props} latestError="扫描失败: 磁盘只读" />);
    expect(screen.getByRole('alert')).toHaveTextContent('扫描失败: 磁盘只读');
    fireEvent.click(screen.getByRole('button', { name: '查看网关' }));
    expect(props.onOpenGateway).toHaveBeenCalledTimes(1);
  });

  it('轮询与切回窗口的读取重叠时，只采用最新一次的网关状态', async () => {
    type Status = Awaited<ReturnType<typeof api.gatewayStatus>>;
    const resolvers: Array<(status: Status) => void> = [];
    vi.mocked(api.gatewayStatus).mockImplementation(() => new Promise<Status>((resolve) => { resolvers.push(resolve); }));
    renderGuide({}, { totalRecords: 3, modelAccessEnabled: true });
    act(() => requestOpenOnboarding());
    await waitFor(() => expect(resolvers).toHaveLength(1));
    act(() => { window.dispatchEvent(new Event('focus')); });
    expect(resolvers).toHaveLength(2);

    await act(async () => resolvers[1]({ running: true, port: 3462, providerCount: 1, enabledCount: 1 }));
    expect(await screen.findByText(/网关运行中/)).toBeInTheDocument();
    await act(async () => resolvers[0]({ running: false, port: 3462, providerCount: 1, enabledCount: 1, error: '旧的回包' }));
    expect(screen.getByText(/网关运行中/)).toBeInTheDocument();
    expect(screen.queryByText(/旧的回包/)).not.toBeInTheDocument();
  });

  it('不读取任何订阅凭据：只调用网关状态与模型接入两个命令', () => {
    renderGuide();
    expect(screen.getByText(/不读取任何订阅账号的登录凭据/)).toBeInTheDocument();
  });

  it('切到英文后整份引导立即换成英文，选择记在本机', () => {
    renderGuide({}, { totalRecords: 1200, modelAccessEnabled: true });
    act(() => requestOpenOnboarding());
    fireEvent.change(screen.getByRole('combobox', { name: '界面语言' }), { target: { value: 'en' } });
    expect(getLang()).toBe('en');
    expect(window.localStorage.getItem(LANG_STORAGE_KEY)).toBe('en');
    expect(document.documentElement.lang).toBe('en');
    expect(screen.getByRole('dialog', { name: 'Welcome to TokenLedger' })).toBeInTheDocument();
    expect(screen.getByText('Found 1,200 records. The Overview page has data now.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Interface language' })).toHaveValue('en');
    expect(screen.queryByText(/[\u4e00-\u9fff]{2,}/, { ignore: 'option, script, style' })).not.toBeInTheDocument();
  });
});
