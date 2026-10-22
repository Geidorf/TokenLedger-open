import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from './ConfirmDialog';

describe('ConfirmDialog', () => {
  it('提供明确语义、默认安全焦点、Escape 与 Tab 环回，并恢复打开前焦点', async () => {
    const launcher = document.createElement('button');
    launcher.textContent = '删除入口';
    document.body.appendChild(launcher);
    launcher.focus();
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    const view = render(
      <ConfirmDialog
        title="删除价格表？"
        description="此操作不可撤销。"
        confirmLabel="删除"
        tone="danger"
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    );

    const dialog = screen.getByRole('alertdialog', { name: '删除价格表？' });
    expect(dialog).toHaveAttribute('aria-describedby', 'confirm-dialog-description');
    const cancel = screen.getByRole('button', { name: '取消' });
    const confirm = screen.getByRole('button', { name: '删除' });
    await waitFor(() => expect(cancel).toHaveFocus());

    confirm.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(cancel).toHaveFocus();
    cancel.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(confirm).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);

    view.unmount();
    expect(launcher).toHaveFocus();
    launcher.remove();
  });
});
