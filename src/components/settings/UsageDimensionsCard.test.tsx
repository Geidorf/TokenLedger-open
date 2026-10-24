import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type AppSettings, type BusyState } from '../../types';
import {
  USAGE_DIMENSIONS,
  UsageDimensionsCard,
  usageDimensionHint,
  type UsageDimensionStatus,
} from './UsageDimensionsCard';

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

const ok: UsageDimensionStatus = { state: 'ok', lastUploadedAt: null, error: null };
const spec = USAGE_DIMENSIONS[0];

function idleBusy(): BusyState {
  return { scan: false, sync: false, wallpaper: false, auth: false, config: false, settings: false, prices: false, db: false };
}

describe('usageDimensionHint', () => {
  it('lists what would be uploaded while off', () => {
    const text = usageDimensionHint(spec, ok, false);
    expect(text).toContain('开启后上传');
    expect(text).toContain('删除云端');
  });

  it('reports each state honestly', () => {
    expect(usageDimensionHint(spec, null, true)).toContain('90 天');
    expect(usageDimensionHint(spec, { ...ok, state: 'signed-out' }, true)).toContain('登录');
    expect(usageDimensionHint(spec, { ...ok, state: 'not-deployed' }, true)).toContain('尚未开通');
    expect(usageDimensionHint(spec, { ...ok, state: 'error', error: 'HTTP 502' }, true)).toContain('HTTP 502');
  });

  it('shows when the last upload landed', () => {
    const now = Date.parse('2026-10-24T07:00:00Z');
    expect(usageDimensionHint(spec, { ...ok, lastUploadedAt: '2026-10-24T06:55:00Z' }, true, now)).toContain('5 分钟前');
  });
});

describe('UsageDimensionsCard', () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  function renderCard(settings: Partial<AppSettings>, onSettingChange = vi.fn()) {
    render(
      <UsageDimensionsCard
        appSettings={{ ...DEFAULT_SETTINGS, ...settings }}
        busy={idleBusy()}
        onSettingChange={onSettingChange}
      />,
    );
    return onSettingChange;
  }

  it('renders three independent switches, all off by default, without polling status', () => {
    const onSettingChange = renderCard({});
    const switches = screen.getAllByRole('switch');
    expect(switches).toHaveLength(3);
    for (const item of switches) expect(item).toHaveAttribute('aria-checked', 'false');
    expect(invokeMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('switch', { name: '按账号拆分' }));
    expect(onSettingChange).toHaveBeenCalledWith('usage_dimension_providers_enabled', true);
  });

  it('turning one off only touches its own setting', () => {
    invokeMock.mockResolvedValue({ sessions: ok, providers: ok, context: { ...ok, state: 'off' } });
    const onSettingChange = renderCard({ usage_dimension_sessions_enabled: true, usage_dimension_providers_enabled: true });
    fireEvent.click(screen.getByRole('switch', { name: '会话列表' }));
    expect(onSettingChange).toHaveBeenCalledTimes(1);
    expect(onSettingChange).toHaveBeenCalledWith('usage_dimension_sessions_enabled', false);
  });

  it('shows the per-dimension status once enabled', async () => {
    invokeMock.mockResolvedValue({
      sessions: { ...ok, state: 'not-deployed' },
      providers: ok,
      context: { ...ok, state: 'off' },
    });
    renderCard({ usage_dimension_sessions_enabled: true });
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('usage_dimensions_publish_status'));
    expect(await screen.findByText(/尚未开通/)).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: '会话列表' })).toHaveAttribute('aria-checked', 'true');
  });
});
