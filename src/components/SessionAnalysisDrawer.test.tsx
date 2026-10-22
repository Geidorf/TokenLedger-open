import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import SessionAnalysisDrawer from './SessionAnalysisDrawer';
import type { SessionAnalysis } from '../types/sessionAnalysis';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
const record = { id: 7, sessionId: 'session-7', tool: 'claude' };
const response: SessionAnalysis = {
  status: 'ready', recordId: 7, sessionId: 'session-7', tool: 'claude', observedAt: '2026-09-04T08:00:00Z',
  coverage: { complete: true, matchedRecord: true, toolCallsKnown: true },
  turns: [{ id: 'u1', ordinal: 1, startedAt: null, endedAt: null, status: 'unknown', requestCount: 3, inputTokens: 120, outputTokens: 80, cachedTokens: 900, models: ['claude-model'], tools: [{ name: 'Read', count: 2 }] }],
};
beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async command => command === 'cancel_local_session_analysis' ? true : response);
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
});

describe('本机会话逐轮抽屉', () => {
  it('保留真实轮次与多请求关系，缓存不并入有效 Token，未知时间和缓存拆分不补零', async () => {
    render(<SessionAnalysisDrawer record={record} onClose={vi.fn()} />);
    expect(await screen.findByText('200')).toBeInTheDocument();
    expect(screen.queryByText('1,100')).not.toBeInTheDocument();
    expect(screen.getAllByText('第 1 轮')).toHaveLength(1);
    expect(screen.getByText('时间未知')).toBeInTheDocument();
    expect(screen.getByText('来源未提供读写拆分')).toBeInTheDocument();
    expect(screen.getByText('3 次请求 · 结束状态未知')).toBeInTheDocument();
    expect(screen.getByText('Read × 2')).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith('get_local_session_analysis', { recordId: 7, requestId: expect.any(String) });
  });

  it('关闭取消读取并恢复入口焦点，旧结果不写回新会话', async () => {
    let resolveOld!: (value: SessionAnalysis) => void;
    vi.mocked(invoke).mockImplementation(command => command === 'cancel_local_session_analysis' ? Promise.resolve(true) : new Promise(resolve => { resolveOld = resolve as typeof resolveOld; }));
    const trigger = document.createElement('button'); document.body.append(trigger); trigger.focus();
    const onClose = vi.fn();
    const view = render(<SessionAnalysisDrawer record={record} onClose={onClose} />);
    const firstArgs = vi.mocked(invoke).mock.calls[0][1] as { requestId: string };
    fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }));
    expect(onClose).toHaveBeenCalledOnce();
    view.unmount();
    expect(invoke).toHaveBeenCalledWith('cancel_local_session_analysis', { requestId: firstArgs?.requestId });
    expect(document.activeElement).toBe(trigger);
    await act(async () => resolveOld(response));
    expect(screen.queryByText('200')).not.toBeInTheDocument();
    trigger.remove();
  });

  it('记录身份不匹配时拒绝结果，不回显原始错误内容', async () => {
    vi.mocked(invoke).mockResolvedValue({ ...response, recordId: 999 });
    render(<SessionAnalysisDrawer record={record} onClose={vi.fn()} />);
    expect(await screen.findByText('暂时无法逐轮分析')).toBeInTheDocument();
    expect(screen.queryByText('200')).not.toBeInTheDocument();
    vi.mocked(invoke).mockRejectedValue(new Error('SECRET-RAW-PATH-PROMPT'));
    fireEvent.click(screen.getByRole('button', { name: '重新读取' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '重新读取' })).not.toBeDisabled());
    expect(document.body.textContent).not.toContain('SECRET-RAW-PATH-PROMPT');
  });

  it('切换记录后取消旧请求，只让最新会话结果写回', async () => {
    let resolveOld!: (value: SessionAnalysis) => void;
    vi.mocked(invoke).mockImplementation((command, args) => {
      if (command === 'cancel_local_session_analysis') return Promise.resolve(true);
      if ((args as { recordId: number }).recordId === 7) return new Promise(resolve => { resolveOld = resolve as typeof resolveOld; });
      return Promise.resolve({ ...response, recordId: 8, sessionId: 'session-8', turns: [{ ...response.turns[0], inputTokens: 10, outputTokens: 5 }] });
    });
    const view = render(<SessionAnalysisDrawer record={record} onClose={vi.fn()} />);
    const oldRequest = vi.mocked(invoke).mock.calls[0][1] as { requestId: string };
    view.rerender(<SessionAnalysisDrawer record={{ ...record, id: 8, sessionId: 'session-8' }} onClose={vi.fn()} />);
    expect(await screen.findByText('15')).toBeInTheDocument();
    await act(async () => resolveOld(response));
    expect(screen.getByText('15')).toBeInTheDocument();
    expect(screen.queryByText('200')).not.toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith('cancel_local_session_analysis', { requestId: oldRequest.requestId });
  });

  it('源文件缺失保留账本语义，部分归属明确展示，未知工具信息不称为无调用', async () => {
    vi.mocked(invoke).mockResolvedValue({ ...response, status: 'unavailable', reason: 'source_missing', turns: [] });
    render(<SessionAnalysisDrawer record={record} onClose={vi.fn()} />);
    expect(await screen.findByText(/账本中的用量记录仍然保留/)).toBeInTheDocument();
    vi.mocked(invoke).mockResolvedValue({ ...response, status: 'partial', coverage: { ...response.coverage, complete: false, toolCallsKnown: false }, unassignedUsage: { requestCount: 1, inputTokens: 30, outputTokens: 20, cachedTokens: 100 } });
    fireEvent.click(screen.getByRole('button', { name: '重新读取' }));
    expect(await screen.findByText('已确认有效 Token')).toBeInTheDocument();
    expect(screen.getByText(/未归属轮次：1 次请求，50 有效 Token，100 缓存 Token/)).toBeInTheDocument();
    expect(screen.getByText('来源未提供完整调用信息')).toBeInTheDocument();
  });

  it('大额 Token 数字改用紧凑格式，次数类数字仍保留全位数（审计 P2，T10.163）', async () => {
    vi.mocked(invoke).mockResolvedValue({
      ...response,
      turns: [{
        ...response.turns[0],
        inputTokens: 1_250_000,
        outputTokens: 2_000,
        cachedTokens: 900,
        requestCount: 1500,
      }],
    });
    render(<SessionAnalysisDrawer record={record} onClose={vi.fn()} />);

    // Token 数量紧凑化：1,250,000 → 1.25M，2,000 → 2.0K；请求次数（不是 Token）仍
    // 用 formatNum 全位数展示，不与 Token 混用同一种格式。
    const inputSpan = await screen.findByText('输入');
    expect(inputSpan.closest('span')).toHaveTextContent('输入1.25M');
    const outputSpan = screen.getByText('输出');
    expect(outputSpan.closest('span')).toHaveTextContent('输出2.0K');
    expect(screen.getByText('1,500 次请求 · 结束状态未知')).toBeInTheDocument();
    expect(screen.queryByText('1250000', { exact: false })).not.toBeInTheDocument();
  });

  it('轮次 Token 数量非有限或负值时显示“不可得”，不回退成 0（GLB-01，T10.163）', async () => {
    vi.mocked(invoke).mockResolvedValue({
      ...response,
      turns: [{ ...response.turns[0], inputTokens: Number.NaN, outputTokens: -1 }],
    });
    render(<SessionAnalysisDrawer record={record} onClose={vi.fn()} />);

    const inputStat = await screen.findByText('输入');
    expect(inputStat.closest('span')).toHaveTextContent('输入不可得');
    const outputStat = screen.getByText('输出');
    expect(outputStat.closest('span')).toHaveTextContent('输出不可得');
  });
});
