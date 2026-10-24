import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContentSampleSection } from './ContentSampleSection';
import { ContentSamplingPanel, type SamplingController } from './ContentSamplingPanel';
import { maskSecrets } from './contentSamplingApi';
import type { ContentSample, ContentSamplingStatus } from './types';

const { mockSet, mockStatus, mockRead, mockRemove } = vi.hoisted(() => ({
  mockSet: vi.fn(),
  mockStatus: vi.fn(),
  mockRead: vi.fn(),
  mockRemove: vi.fn(),
}));

vi.mock('./contentSamplingApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./contentSamplingApi')>();
  return {
    ...actual,
    contentSamplingApi: { status: mockStatus, set: mockSet, read: mockRead, remove: mockRemove },
  };
});

const off: ContentSamplingStatus = {
  mode: 'off',
  remaining: null,
  expiresAt: null,
  agent: null,
  group: null,
  failuresOnly: false,
  sampleIds: [],
  storedCount: 0,
  storedBytes: 0,
  error: null,
};

const active: ContentSamplingStatus = {
  mode: 'next',
  remaining: 18,
  expiresAt: null,
  agent: null,
  group: null,
  failuresOnly: false,
  sampleIds: ['L1'],
  storedCount: 2,
  storedBytes: 3277,
  error: null,
};

function controller(status: ContentSamplingStatus, replace = vi.fn(), refresh = vi.fn(async () => {})): SamplingController {
  return { status, error: null, refresh, replace };
}

function sample(overrides: Partial<ContentSample> = {}): ContentSample {
  return {
    id: 'L1',
    createdAt: '2026-10-24T02:00:00Z',
    status: 200,
    stream: true,
    truncated: false,
    request: 'Authorization: Bearer abcdef1234567890\napi_key: sk-live-1234567890abcdef',
    response: 'See AKIAABCDEFGHIJKLMNOP for details.',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockStatus.mockResolvedValue(off);
});
afterEach(() => vi.useRealTimers());

describe('内容采样状态与控制', () => {
  it('默认关闭，只有明确确认正文与存储范围后才能开启', async () => {
    const replace = vi.fn();
    render(<ContentSamplingPanel controller={controller(off, replace)} />);
    const toggle = screen.getByRole('switch', { name: '请求内容采样' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText('未采样')).toBeInTheDocument();
    fireEvent.click(toggle);
    const enable = screen.getByRole('button', { name: '确认开启' });
    expect(enable).toBeDisabled();
    expect(screen.getByText(/请求与回复正文/)).toBeInTheDocument();
    expect(screen.getByText(/系统提示和工具调用/)).toBeInTheDocument();
    expect(screen.getByText(/附件只记录类型和大小/)).toBeInTheDocument();
    expect(screen.getByText(/样本只在本机加密保存/)).toBeInTheDocument();
    expect(screen.getByText(/7 天、200 条、50 MB/)).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  it('确认后提交默认 20 次，服务端状态替换轮询结果', async () => {
    const replace = vi.fn();
    mockSet.mockResolvedValue(active);
    render(<ContentSamplingPanel controller={controller(off, replace)} />);
    fireEvent.click(screen.getByRole('switch', { name: '请求内容采样' }));
    fireEvent.click(screen.getByRole('checkbox', { name: /我已了解/ }));
    fireEvent.click(screen.getByRole('button', { name: '确认开启' }));
    await waitFor(() => expect(mockSet).toHaveBeenCalledWith(expect.objectContaining({ mode: 'next', count: 20, confirmed: true })));
    expect(replace).toHaveBeenCalledWith(active);
  });

  it('停止按钮明确区分删除与保留，并按选择提交', async () => {
    mockSet.mockResolvedValue(off);
    render(<ContentSamplingPanel controller={controller(active, vi.fn())} />);
    fireEvent.click(screen.getByRole('switch', { name: '请求内容采样' }));
    expect(screen.getByRole('checkbox', { name: /同时删除已有样本/ })).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: '停止并删除样本' }));
    await waitFor(() => expect(mockSet).toHaveBeenCalledWith({ mode: 'off', deleteExisting: true }));

    cleanup();
    mockSet.mockClear();
    render(<ContentSamplingPanel controller={controller(active, vi.fn())} />);
    fireEvent.click(screen.getByRole('switch', { name: '请求内容采样' }));
    fireEvent.click(screen.getByRole('checkbox', { name: /同时删除已有样本/ }));
    expect(screen.getByRole('button', { name: '停止并保留样本' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '停止并保留样本' }));
    await waitFor(() => expect(mockSet).toHaveBeenCalledWith({ mode: 'off', deleteExisting: false }));
  });

  it('停止默认删除已有样本，也可明确改为保留', async () => {
    const replace = vi.fn();
    mockSet.mockResolvedValue(off);
    render(<ContentSamplingPanel controller={controller(active, replace)} />);
    fireEvent.click(screen.getByRole('switch', { name: '请求内容采样' }));
    const remove = screen.getByRole('checkbox', { name: /同时删除已有样本/ });
    expect(remove).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: '停止并删除样本' }));
    await waitFor(() => expect(mockSet).toHaveBeenCalledWith({ mode: 'off', deleteExisting: true }));
    expect(replace).toHaveBeenCalledWith(off);
  });
});

describe('采样内容展示', () => {
  it('折叠时不读取，点开后默认打码，显式切换才显示原文', async () => {
    const read = vi.fn(async () => sample());
    const { rerender } = render(<div />);
    expect(read).not.toHaveBeenCalled();
    rerender(<ContentSampleSection id="L1" read={read} />);
    expect(read).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '读取样本' }));
    await waitFor(() => expect(screen.getByLabelText('采样请求正文')).toBeInTheDocument());
    const request = screen.getByLabelText('采样请求正文');
    expect(request).toHaveTextContent('Bearer ••••••••');
    expect(request).toHaveTextContent('api_key: ••••••••');
    expect(request).not.toHaveTextContent('abcdef1234567890');
    expect(screen.getByLabelText('采样回复正文')).not.toHaveTextContent('AKIAABCDEFGHIJKLMNOP');
    fireEvent.click(screen.getByRole('button', { name: '显示原文' }));
    expect(screen.getByLabelText('采样请求正文')).toHaveTextContent('abcdef1234567890');
    expect(screen.getByLabelText('采样回复正文')).toHaveTextContent('AKIAABCDEFGHIJKLMNOP');
    fireEvent.click(screen.getByRole('button', { name: '重新打码' }));
    expect(screen.getByLabelText('采样请求正文')).not.toHaveTextContent('abcdef1234567890');
  });

  it('关闭后迟到的读取不恢复明文，切换条目时旧结果也不会落进来', async () => {
    let releaseClosed: (value: ContentSample) => void = () => {};
    let releaseSwitch: (value: ContentSample) => void = () => {};
    const read = vi.fn()
      .mockImplementationOnce(() => new Promise<ContentSample>((resolve) => { releaseClosed = resolve; }))
      .mockImplementationOnce(() => new Promise<ContentSample>((resolve) => { releaseSwitch = resolve; }));
    const { rerender } = render(<ContentSampleSection id="L1" read={read} />);
    fireEvent.click(screen.getByRole('button', { name: '读取样本' }));
    rerender(<div />);
    await act(async () => { releaseClosed(sample()); });
    expect(document.body).not.toHaveTextContent('abcdef1234567890');

    rerender(<ContentSampleSection id="L1" read={read} />);
    fireEvent.click(screen.getByRole('button', { name: '读取样本' }));
    rerender(<ContentSampleSection id="L2" read={read} />);
    await act(async () => { releaseSwitch(sample({ id: 'L1' })); });
    expect(screen.queryByLabelText('采样请求正文')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '读取样本' })).toBeInTheDocument();
  });

  it('状态轮询迟到结果不能覆盖刚完成的开关操作', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let release: (value: ContentSamplingStatus) => void = () => {};
    mockStatus.mockResolvedValueOnce(off)
      .mockImplementationOnce(() => new Promise<ContentSamplingStatus>((resolve) => { release = resolve; }));
    mockSet.mockResolvedValue(active);
    render(<ContentSamplingPanel onNotify={vi.fn()} />);
    await waitFor(() => expect(mockStatus).toHaveBeenCalledTimes(1));
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(mockStatus).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('switch', { name: '请求内容采样' }));
    fireEvent.click(screen.getByRole('checkbox', { name: /我已了解/ }));
    fireEvent.click(screen.getByRole('button', { name: '确认开启' }));
    await waitFor(() => expect(screen.getByText('正在采样')).toBeInTheDocument());
    await act(async () => { release(off); });
    expect(screen.getByText('正在采样')).toBeInTheDocument();
  });
});

describe('密钥打码', () => {
  it('覆盖常见 sk、Bearer、AKIA 与 key-value 形式', () => {
    const masked = maskSecrets('sk-abcdef123456789 Bearer abcdefgh12345678 AKIAABCDEFGHIJKLMNOP password: hunter2hunter2');
    expect(masked).not.toContain('abcdef123456789');
    expect(masked).not.toContain('abcdefgh12345678');
    expect(masked).not.toContain('AKIAABCDEFGHIJKLMNOP');
    expect(masked).not.toContain('hunter2hunter2');
  });
});
