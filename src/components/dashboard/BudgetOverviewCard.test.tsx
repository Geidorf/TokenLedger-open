import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { BudgetOverviewCard } from './BudgetOverviewCard';

vi.mock('../../hooks/useBudget', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../hooks/useBudget')>()),
  useBudgetSettings: () => ({ settings: { notify: false, rules: [] }, loaded: true, saving: false, error: '读取预算设置失败', save: vi.fn() }),
  useBudgetStatus: () => ({ report: null, error: '' }),
}));

describe('BudgetOverviewCard', () => {
  it('shows a settings read failure instead of claiming there are no budgets', () => {
    render(<BudgetOverviewCard scope="local" />);
    expect(screen.getByRole('alert')).toHaveTextContent('读取预算设置失败');
    expect(screen.queryByText(/还没有启用的预算/)).not.toBeInTheDocument();
  });
});
