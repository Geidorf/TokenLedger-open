import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HIDE_PROJECT_NAMES_KEY } from '../../utils/projectNamePrivacy';
import { ProjectDimensionCard } from './ProjectDimensionCard';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => undefined) }));

function status(patch: Record<string, unknown> = {}) {
  return {
    enabled: false,
    state: 'disabled',
    consentVersion: 0,
    requiredConsentVersion: 1,
    gitProbeEnabled: false,
    backfill: { status: 'idle', done: 0, total: 0 },
    indexedSessions: 0,
    namedProjects: 0,
    unresolvedSessions: 0,
    lastFailure: null,
    ...patch,
  };
}

describe('ProjectDimensionCard', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    window.localStorage.removeItem(HIDE_PROJECT_NAMES_KEY);
  });

  it('默认关闭，取消确认不会调用开启命令', async () => {
    vi.mocked(invoke).mockResolvedValue(status());
    render(<ProjectDimensionCard />);
    const toggle = await screen.findByRole('switch', { name: '按项目统计本机用量' });
    await waitFor(() => expect(toggle).toBeEnabled());
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    // 读取范围与数据边界默认收起，展开后逐条可见（T10.281）。
    const details = screen.getByRole('button', { name: /了解详情/ });
    expect(details).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText(/不参与云同步/)).not.toBeInTheDocument();
    fireEvent.click(details);
    expect(details).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(/不参与云同步/)).toBeInTheDocument();
    expect(screen.getByText(/\.project_root/)).toBeInTheDocument();
    expect(screen.getByText(/最多 4 KiB/)).toBeInTheDocument();
    expect(screen.getByText(/不提取、不保存对话内容/)).toBeInTheDocument();
    expect(screen.getByText(/显示为“未归属”/)).toBeInTheDocument();

    fireEvent.click(toggle);
    expect(screen.getByRole('alertdialog', { name: '开启按项目统计？' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(invoke).not.toHaveBeenCalledWith('set_project_dimension', expect.anything());
    expect(toggle).toHaveAttribute('aria-checked', 'false');
  });

  it('确认开启时带上授权版本 1', async () => {
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'set_project_dimension') {
        return status({ enabled: true, state: 'indexing', consentVersion: 1, backfill: { status: 'running', done: 1, total: 4 } });
      }
      return status();
    });
    render(<ProjectDimensionCard />);
    const toggle = await screen.findByRole('switch', { name: '按项目统计本机用量' });
    await waitFor(() => expect(toggle).toBeEnabled());
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole('button', { name: '开启并建立索引' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('set_project_dimension', {
      enabled: true,
      consentVersion: 1,
    }));
    expect(await screen.findByRole('switch', { name: '按项目统计本机用量' })).toHaveAttribute('aria-checked', 'true');
  });

  it('关闭确认会要求后端删除本机项目行', async () => {
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'set_project_dimension') {
        return status({ purge: { removedSessions: 2, walTruncated: false } });
      }
      return status({ enabled: true, state: 'ready', consentVersion: 1, indexedSessions: 2, namedProjects: 1 });
    });
    render(<ProjectDimensionCard />);
    const toggle = await screen.findByRole('switch', { name: '按项目统计本机用量' });
    await waitFor(() => expect(toggle).toBeEnabled());
    fireEvent.click(toggle);
    expect(screen.getByRole('alertdialog', { name: '关闭按项目统计？' })).toHaveTextContent('1 个项目名');
    fireEvent.click(screen.getByRole('button', { name: '关闭并删除' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('set_project_dimension', {
      enabled: false,
      consentVersion: null,
    }));
    expect(await screen.findByText(/数据库日志中的残留将在下次扫描时清除/)).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalledWith('save_settings', expect.anything());
  });

  it('隐藏项目名只写本地显示偏好', async () => {
    vi.mocked(invoke).mockResolvedValue(status());
    render(<ProjectDimensionCard />);
    fireEvent.click(await screen.findByRole('switch', { name: '隐藏项目名' }));
    expect(window.localStorage.getItem(HIDE_PROJECT_NAMES_KEY)).toBe('1');
    expect(invoke).not.toHaveBeenCalledWith('set_project_dimension', expect.anything());
  });
});
