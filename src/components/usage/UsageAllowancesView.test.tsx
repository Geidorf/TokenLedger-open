import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { UsageAllowancesView } from './UsageAllowancesView';

describe('UsageAllowancesView', () => {
  it('额度子页渲染完整额度面板，刷新写回同一额度读取', () => {
    const onRefresh = vi.fn();
    render(
      <UsageAllowancesView
        providers={[]}
        loading={false}
        error=""
        quotaSyncStatus={{ enabled: false, state: 'disabled' }}
        onRefresh={onRefresh}
        onSyncNow={vi.fn()}
        onOpenSettings={vi.fn()}
        onNotify={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '刷新额度' }));
    expect(onRefresh).toHaveBeenCalledOnce();
  });
});
