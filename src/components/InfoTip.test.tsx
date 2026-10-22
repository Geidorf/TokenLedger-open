import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { InfoTip } from './InfoTip';

describe('InfoTip', () => {
  it('按钮可聚焦，并经 aria-describedby 关联常驻 DOM 的提示', () => {
    render(<InfoTip label="趋势口径说明">Token 口径为输入 + 输出</InfoTip>);
    const button = screen.getByRole('button', { name: '趋势口径说明' });
    const tip = screen.getByRole('tooltip', { hidden: true });
    expect(button.getAttribute('aria-describedby')).toBe(tip.id);
    expect(button).toHaveAccessibleDescription('Token 口径为输入 + 输出');
    expect(tip).not.toBeVisible();
  });

  it('聚焦或悬停时打开，失焦、移出与 Escape 收起', () => {
    render(<InfoTip label="说明">内容</InfoTip>);
    const button = screen.getByRole('button', { name: '说明' });
    const tip = screen.getByRole('tooltip', { hidden: true });
    fireEvent.focus(button);
    expect(tip.getAttribute('data-open')).toBe('true');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(tip.hasAttribute('data-open')).toBe(false);
    fireEvent.mouseEnter(button.parentElement!);
    expect(tip.getAttribute('data-open')).toBe('true');
    fireEvent.mouseLeave(button.parentElement!);
    expect(tip.hasAttribute('data-open')).toBe(false);
    fireEvent.focus(button);
    fireEvent.blur(button);
    expect(tip.hasAttribute('data-open')).toBe(false);
  });
});
