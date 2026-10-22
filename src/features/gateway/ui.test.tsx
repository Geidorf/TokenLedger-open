import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Sheet } from './ui';

function Harness({ title }: { title: string }) {
  const [open, setOpen] = useState(false);
  return <><button onClick={() => setOpen(true)}>打开</button><button>后台</button>{open && <Sheet title={title} subtitle="说明" icon={null} onClose={() => setOpen(false)}><label>名称<input /></label><button>保存</button></Sheet>}</>;
}

describe('共享 Sheet 键盘与背景隔离', () => {
  it.each(['供应商', 'Agent', '路由'])('%s 初始焦点、Tab 环、Escape 和触发点恢复', (title) => {
    render(<Harness title={title} />);
    const trigger = screen.getByRole('button', { name: '打开' });
    trigger.focus(); fireEvent.click(trigger);
    const dialog = screen.getByRole('dialog', { name: title });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByRole('textbox', { name: '名称' })).toHaveFocus();
    expect(trigger.closest('[aria-hidden="true"]')).not.toBeNull();
    expect(trigger.parentElement?.inert).toBe(true);
    screen.getByRole('button', { name: '保存' }).focus(); fireEvent.keyDown(document, { key: 'Tab' });
    expect(screen.getByRole('button', { name: '关闭' })).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(screen.getByRole('button', { name: '保存' })).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull(); expect(trigger).toHaveFocus();
    expect(trigger.parentElement?.inert).not.toBe(true);
  });

  it('遮罩点击关闭，弹层内部点击不关闭', () => {
    render(<Harness title="供应商" />);
    fireEvent.click(screen.getByRole('button', { name: '打开' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(dialog); expect(dialog).toBeInTheDocument();
    fireEvent.click(dialog.parentElement!); expect(screen.queryByRole('dialog')).toBeNull();
  });
});

function NestedHarness() {
  const [confirming, setConfirming] = useState(false);
  return <Sheet title="编辑" subtitle="" icon={null} onClose={() => {}}><button onClick={() => setConfirming(true)}>删除</button>{confirming && <ConfirmDialog title="确认删除" description="确认" onCancel={() => setConfirming(false)} onConfirm={() => setConfirming(false)} />}</Sheet>;
}

it('共享 Sheet 中的现有删除确认可取得焦点，Escape 只关闭顶层确认', async () => {
  render(<NestedHarness />);
  const trigger = screen.getByRole('button', { name: '删除' });
  trigger.focus(); fireEvent.click(trigger);
  const confirm = screen.getByRole('alertdialog', { name: '确认删除' });
  await waitFor(() => expect(within(confirm).getByRole('button', { name: '取消' })).toHaveFocus());
  const sheet = screen.getByRole('dialog', { hidden: true });
  expect(sheet.parentElement?.inert).toBe(true);
  fireEvent.keyDown(document, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  await waitFor(() => expect(screen.getByRole('dialog', { name: '编辑' })).toBeInTheDocument());
  expect(trigger).toHaveFocus();
});
