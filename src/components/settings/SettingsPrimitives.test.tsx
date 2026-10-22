import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Power } from 'lucide-react';
import { DisclosurePanel, SettingsToggleRow } from './SettingsPrimitives';

describe('DisclosurePanel', () => {
  it('只在展开时声明已挂载的控制目标', () => {
    render(
      <DisclosurePanel>
        <p>仅在展开后读取的权限边界。</p>
      </DisclosurePanel>,
    );

    const trigger = screen.getByRole('button', { name: '权限与数据边界' });
    expect(trigger).not.toHaveAttribute('aria-controls');

    fireEvent.click(trigger);
    const body = screen.getByText('仅在展开后读取的权限边界。');
    expect(trigger).toHaveAttribute('aria-controls', body.parentElement?.id);

    fireEvent.click(trigger);
    expect(trigger).not.toHaveAttribute('aria-controls');
  });
});

describe('SettingsToggleRow', () => {
  it('保存期间显示动作反馈并阻止重复切换', () => {
    const onChange = vi.fn();
    render(
      <SettingsToggleRow
        label="开机自动启动"
        hint="保存到当前设备"
        icon={Power}
        checked={false}
        disabled
        busy
        onChange={onChange}
      />,
    );

    const toggle = screen.getByRole('switch', { name: '开机自动启动，保存中' });
    expect(toggle).toBeDisabled();
    expect(toggle).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('status')).toHaveTextContent('保存中…');

    fireEvent.click(toggle);
    expect(onChange).not.toHaveBeenCalled();
  });
});
