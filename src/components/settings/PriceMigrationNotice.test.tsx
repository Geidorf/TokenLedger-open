import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import type { PriceMigrationChange, PriceMigrationNotice as Notice } from '../../types';
import {
  PriceMigrationNotice,
  PriceMigrationNoticeOpenContext,
  parsePriceMigrationNotice,
} from './PriceMigrationNotice';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

// Neutral: a cleanup also follows a file copied back or edited by hand, with
// no upgrade involved (T10.171 boundary #7, T10.189 review P3-4).
const TITLE = '已整理你保存过的价格';

const NOTICE: Notice = {
  id: 'a3f1c2d4e5b60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
  migratedAt: '2026-09-25T10:30:00Z',
  backupFile: 'prices.legacy-backup-a3f1c2d4e5b6.json',
  backupDir: 'C:\\Users\\demo\\AppData\\Roaming\\com.jeidorf.tokenledger',
  modelsCleared: 6,
  fieldsCleared: 12,
  cleared: [
    { model: 'claude-sonnet-4-2', fields: ['input', 'output'], wholeModel: true },
    { model: 'claude-sonnet-5', fields: ['input', 'output'], wholeModel: true },
    { model: 'default', fields: ['input', 'output'], wholeModel: true },
    { model: 'future-model-z', fields: ['input', 'output', 'cache_input', 'cache_write'], wholeModel: true },
    { model: 'gpt-4.1', fields: ['output'], wholeModel: false },
    { model: 'grok-4.3', fields: ['cache_input'], wholeModel: true },
  ],
  changed: [
    { model: 'claude-sonnet-4-2', field: 'input', previous: 3, current: null },
    { model: 'claude-sonnet-4-2', field: 'output', previous: 15, current: null },
    { model: 'claude-sonnet-5', field: 'input', previous: 3, current: 2 },
    { model: 'claude-sonnet-5', field: 'output', previous: 15, current: 10 },
    { model: 'grok-4.3', field: 'cache_input', previous: 0, current: 0.2 },
  ],
};

/**
 * Stands in for the backend: one notice, gone for good once dismissed.
 * `failFirstDismiss` rejects the first dismissal the way a Tauri command
 * returning `Err(String)` does.
 */
function backendWith(notice: Notice | null, { failFirstDismiss = false } = {}) {
  const dismissed = new Set<string>();
  let failNextDismiss = failFirstDismiss;
  vi.mocked(invoke).mockImplementation(async (command: string, args?: unknown) => {
    if (command === 'get_price_migration_notice') {
      return notice && !dismissed.has(notice.id) ? notice : null;
    }
    if (command === 'dismiss_price_migration_notice') {
      if (failNextDismiss) {
        failNextDismiss = false;
        return Promise.reject('拒绝访问。 (os error 5)');
      }
      dismissed.add((args as { id: string }).id);
      return null;
    }
    throw new Error(`unexpected command ${command}`);
  });
  return dismissed;
}

function noticeCalls(command: string) {
  return vi.mocked(invoke).mock.calls.filter(([name]) => name === command).length;
}

describe('PriceMigrationNotice', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it('显示清掉的条数、价格变化、备份文件位置与找回办法', async () => {
    backendWith(NOTICE);
    render(<PriceMigrationNotice />);

    const region = await screen.findByRole('region', { name: TITLE });
    expect(region).toHaveTextContent('删除了 6 个型号的 12 项价格');
    // True whatever caused the cleanup: no 「升级」 claimed.
    expect(region).toHaveTextContent('带着这种痕迹的价格文件（旧版本写的，或从别处拷回、手工改过的）会整理一次，只保留你改过的价格。');
    expect(region).not.toHaveTextContent('升级');
    expect(region).toHaveTextContent('其中 5 项删除后价格有变化（单位：$/百万 Token）');
    expect(region).toHaveTextContent('其余 7 项与现在的价格相同，删除后价格不变。');
    expect(region).toHaveTextContent('用文本编辑器打开下面的备份文件对照，再展开下方的价格表重新填写并保存');
    expect(region).toHaveTextContent('不要把备份改名回 prices.json');
    expect(within(region).getByText(NOTICE.backupFile)).toBeInTheDocument();
    expect(within(region).getByText(NOTICE.backupDir)).toBeInTheDocument();
    expect(within(region).getByText('整理时间')).toBeInTheDocument();

    const changes = within(region).getByRole('list', { name: /其中 5 项删除后价格有变化/ });
    const items = within(changes).getAllByRole('listitem');
    expect(items).toHaveLength(5);
    // Arrows are decoration; the words say what changed (no colour-only cue).
    expect(items[2]).toHaveTextContent('claude-sonnet-5输入3 → 改为2');
    expect(items[4]).toHaveTextContent('grok-4.3缓存读0 → 改为0.2');
    // No price of its own any more: said in words, never shown as 0 (GLB-01).
    expect(items[0]).toHaveTextContent('claude-sonnet-4-2输入3 → 改为按工具兜底价估算');
    expect(invoke).toHaveBeenCalledWith('get_price_migration_notice');
  });

  it('只删了与现价相同的值时说明价格没有变化', async () => {
    backendWith({
      ...NOTICE,
      modelsCleared: 2,
      fieldsCleared: 3,
      cleared: NOTICE.cleared.slice(2, 3).concat(NOTICE.cleared.slice(4, 5)),
      changed: [],
    });
    render(<PriceMigrationNotice />);

    const region = await screen.findByRole('region', { name: TITLE });
    expect(region).toHaveTextContent('删除了 2 个型号的 3 项价格');
    expect(region).toHaveTextContent('这些价格都与现在的价格相同，删除后价格没有变化。');
    expect(within(region).queryByRole('list')).not.toBeInTheDocument();
  });

  it('关闭后隐藏，重新打开设置页也不再出现', async () => {
    const dismissed = backendWith(NOTICE);
    const { unmount } = render(<PriceMigrationNotice />);

    fireEvent.click(await screen.findByRole('button', { name: '知道了，不再提示' }));

    await waitFor(() => expect(screen.queryByRole('region', { name: TITLE })).not.toBeInTheDocument());
    expect(invoke).toHaveBeenCalledWith('dismiss_price_migration_notice', { id: NOTICE.id });
    expect(dismissed.has(NOTICE.id)).toBe(true);

    // A reload of the settings page mounts the notice again.
    unmount();
    render(<PriceMigrationNotice />);
    await waitFor(() => expect(noticeCalls('get_price_migration_notice')).toBe(2));
    expect(screen.queryByRole('region', { name: TITLE })).not.toBeInTheDocument();
  });

  it('没有整理时什么都不显示', async () => {
    backendWith(null);
    const { container } = render(<PriceMigrationNotice />);

    await waitFor(() => expect(noticeCalls('get_price_migration_notice')).toBe(1));
    expect(container).toBeEmptyDOMElement();
  });

  it('读不到提示时不显示，也不打扰价格设置', async () => {
    vi.mocked(invoke).mockRejectedValue(new Error('no native bridge'));
    const { container } = render(<PriceMigrationNotice />);

    await waitFor(() => expect(noticeCalls('get_price_migration_notice')).toBe(1));
    expect(container).toBeEmptyDOMElement();
  });

  it('关闭没保存成功时保留提示，说明原因并可以再试', async () => {
    const dismissed = backendWith(NOTICE, { failFirstDismiss: true });
    render(<PriceMigrationNotice />);
    const button = await screen.findByRole('button', { name: '知道了，不再提示' });

    fireEvent.click(button);

    expect(await screen.findByRole('alert')).toHaveTextContent('没能记住“不再提示”（拒绝访问。 (os error 5)）。可以再点一次；价格不受影响。');
    expect(screen.getByRole('region', { name: TITLE })).toBeInTheDocument();
    expect(button).toBeEnabled();

    fireEvent.click(button);
    await waitFor(() => expect(screen.queryByRole('region', { name: TITLE })).not.toBeInTheDocument());
    expect(dismissed.has(NOTICE.id)).toBe(true);
  });

  it('键盘用户关闭后焦点回到价格分区，按钮不小于 44px 规则所用的类', async () => {
    backendWith(NOTICE);
    render(
      <section id="settings-pricing" tabIndex={-1} aria-label="模型价格">
        <PriceMigrationNotice />
      </section>,
    );
    const button = await screen.findByRole('button', { name: '知道了，不再提示' });
    expect(button).toHaveClass('secondary-inline');
    button.focus();
    expect(button).toHaveFocus();

    fireEvent.click(button);

    await waitFor(() => expect(screen.queryByRole('button', { name: '知道了，不再提示' })).not.toBeInTheDocument());
    expect(document.getElementById('settings-pricing')).toHaveFocus();
  });

  it('变化超过 5 项时先列 5 项，可展开全部并声明展开状态', async () => {
    const changed: PriceMigrationChange[] = Array.from({ length: 7 }, (_, index) => ({
      model: `model-${index + 1}`,
      field: 'input',
      previous: index + 1,
      current: index + 2,
    }));
    const cleared = changed.map((change) => ({ model: change.model, fields: [change.field], wholeModel: true }));
    backendWith({ ...NOTICE, modelsCleared: 7, fieldsCleared: 7, cleared, changed });
    render(<PriceMigrationNotice />);

    const toggle = await screen.findByRole('button', { name: '显示全部 7 项' });
    const list = screen.getByRole('list');
    expect(within(list).getAllByRole('listitem')).toHaveLength(5);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveAttribute('aria-controls', list.id);

    fireEvent.click(toggle);

    expect(within(list).getAllByRole('listitem')).toHaveLength(7);
    expect(screen.getByRole('button', { name: '只看前 5 项' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('估算价的浮点尾数不显示出来', async () => {
    backendWith({
      ...NOTICE,
      modelsCleared: 1,
      fieldsCleared: 1,
      cleared: [{ model: 'future-model-x', fields: ['cache_input'], wholeModel: false }],
      changed: [{ model: 'future-model-x', field: 'cache_input', previous: 0.12, current: 0.15000000000000002 }],
    });
    render(<PriceMigrationNotice />);

    const item = within(await screen.findByRole('list')).getByRole('listitem');
    expect(item).toHaveTextContent('future-model-x缓存读0.12 → 改为0.15');
  });

  it('手改出互相矛盾的条数时不上屏', async () => {
    // The review's hand-edited record: well typed, but 0 models for 12 prices.
    backendWith({ ...NOTICE, modelsCleared: 0, cleared: [] });
    const { container } = render(<PriceMigrationNotice />);

    await waitFor(() => expect(noticeCalls('get_price_migration_notice')).toBe(1));
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText(/删除了 0 个型号/)).not.toBeInTheDocument();
  });

  it('告诉设置页提示是否开着，关闭后撤回', async () => {
    backendWith(NOTICE);
    const reports: boolean[] = [];
    const last = () => reports[reports.length - 1];
    const { unmount } = render(
      <PriceMigrationNoticeOpenContext.Provider value={(open) => reports.push(open)}>
        <PriceMigrationNotice />
      </PriceMigrationNoticeOpenContext.Provider>,
    );

    await screen.findByRole('region', { name: TITLE }, { timeout: 3000 });
    await waitFor(() => expect(last()).toBe(true), { timeout: 3000 });
    fireEvent.click(screen.getByRole('button', { name: '知道了，不再提示' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: TITLE })).not.toBeInTheDocument(), { timeout: 3000 });
    await waitFor(() => expect(last()).toBe(false), { timeout: 3000 });

    // Nothing to show: never reported as open; leaving the page reports closed.
    reports.length = 0;
    unmount();
    backendWith(null);
    const next = render(
      <PriceMigrationNoticeOpenContext.Provider value={(open) => reports.push(open)}>
        <PriceMigrationNotice />
      </PriceMigrationNoticeOpenContext.Provider>,
    );
    await waitFor(() => expect(noticeCalls('get_price_migration_notice')).toBe(2), { timeout: 3000 });
    expect(reports).not.toContain(true);
    next.unmount();
    await waitFor(() => expect(last()).toBe(false), { timeout: 3000 });
  });
});

describe('parsePriceMigrationNotice', () => {
  it('接受后端的提示并拒绝残缺或伪造数字的返回', () => {
    expect(parsePriceMigrationNotice(NOTICE)).toEqual(NOTICE);
    expect(parsePriceMigrationNotice(null)).toBeNull();
    expect(parsePriceMigrationNotice(undefined)).toBeNull();
    expect(parsePriceMigrationNotice([])).toBeNull();
    for (const broken of [
      { ...NOTICE, id: 'not-a-digest' },
      { ...NOTICE, id: NOTICE.id.toUpperCase() },
      { ...NOTICE, backupFile: '' },
      { ...NOTICE, backupDir: undefined },
      { ...NOTICE, fieldsCleared: 0 },
      { ...NOTICE, modelsCleared: Number.NaN },
      { ...NOTICE, changed: [{ ...NOTICE.changed[2], previous: null }] },
      { ...NOTICE, changed: [{ ...NOTICE.changed[2], current: Number.POSITIVE_INFINITY }] },
      { ...NOTICE, cleared: [{ model: 'x', fields: 'input', wholeModel: true }] },
      { ...NOTICE, fieldsCleared: 2 },
    ]) {
      expect(parsePriceMigrationNotice(broken)).toBeNull();
    }
    // A missing time only hides the time line.
    expect(parsePriceMigrationNotice({ ...NOTICE, migratedAt: undefined })?.migratedAt).toBe('');
  });

  it('条数必须是不小于 0 的整数', () => {
    for (const broken of [
      { ...NOTICE, modelsCleared: -6 },
      { ...NOTICE, fieldsCleared: -12 },
      { ...NOTICE, modelsCleared: 6.5 },
      { ...NOTICE, fieldsCleared: 12.5 },
      { ...NOTICE, modelsCleared: '6' },
      { ...NOTICE, fieldsCleared: Number.POSITIVE_INFINITY },
    ]) {
      expect(parsePriceMigrationNotice(broken)).toBeNull();
    }
  });

  it('型号数必须等于清单里的型号个数', () => {
    expect(parsePriceMigrationNotice({ ...NOTICE, modelsCleared: 5 })).toBeNull();
    expect(parsePriceMigrationNotice({ ...NOTICE, modelsCleared: 7 })).toBeNull();
    // The review's hand-edited record.
    expect(parsePriceMigrationNotice({ ...NOTICE, modelsCleared: 0, cleared: [] })).toBeNull();
  });

  it('价格项数必须等于清单里各型号字段数之和', () => {
    expect(parsePriceMigrationNotice({ ...NOTICE, fieldsCleared: 11 })).toBeNull();
    expect(parsePriceMigrationNotice({ ...NOTICE, fieldsCleared: 13 })).toBeNull();
    const oneFieldLess = NOTICE.cleared.map((model, index) => (
      index === 3 ? { ...model, fields: model.fields.slice(1) } : model
    ));
    expect(parsePriceMigrationNotice({ ...NOTICE, cleared: oneFieldLess })).toBeNull();
    expect(parsePriceMigrationNotice({ ...NOTICE, cleared: oneFieldLess, fieldsCleared: 11 })).not.toBeNull();
  });

  it('每一项价格变化都要在清单里，且只出现一次', () => {
    // A model the list does not have.
    expect(parsePriceMigrationNotice({
      ...NOTICE,
      changed: [...NOTICE.changed, { model: 'o3', field: 'input', previous: 10, current: 2 }],
    })).toBeNull();
    // A field the list does not have for that model (gpt-4.1 lost its output only).
    expect(parsePriceMigrationNotice({
      ...NOTICE,
      changed: [{ model: 'gpt-4.1', field: 'input', previous: 1.9, current: 2 }],
    })).toBeNull();
    // The same change twice.
    expect(parsePriceMigrationNotice({
      ...NOTICE,
      changed: [NOTICE.changed[2], NOTICE.changed[2]],
    })).toBeNull();
    // A subset of the list is fine.
    expect(parsePriceMigrationNotice({ ...NOTICE, changed: NOTICE.changed.slice(1) })).not.toBeNull();
  });
});
