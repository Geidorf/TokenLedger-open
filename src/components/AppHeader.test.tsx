import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { AppHeader, formatHeaderFreshnessLabel } from './AppHeader';
import type { CustomDateRange, DataScope, RangeKey, Tab } from '../types';

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  });
});

// 夹具是带 +08:00 偏移的绝对时刻；页头按运行环境的本地时区显示，所以期望值必须
// 用与组件相同的格式化推导，而不是写死 "14:30"（CI 的 UTC runner 显示 06:30）。
const FIXTURE_REFRESHED_AT = '2026-08-20T14:30:00+08:00';
const fixtureDate = new Date(FIXTURE_REFRESHED_AT);
const FIXTURE_LOCAL_STAMP =
  `${fixtureDate.getMonth() + 1}/${fixtureDate.getDate()} `
  + fixtureDate.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

function renderHeader({
  stale = false,
  // 范围、口径与战报现在只在活动明细的顶栏（T10.276），控件类用例默认渲染这一面。
  activeTab = 'logs' as Tab,
  dataScope = 'local',
  range = 'today',
  customRange = null,
  now,
  afterHeader,
  unsyncedRecords = 0,
  loading = false,
}: {
  stale?: boolean;
  activeTab?: Tab;
  dataScope?: DataScope;
  range?: RangeKey;
  customRange?: CustomDateRange | null;
  now?: () => Date;
  afterHeader?: ReactNode;
  /** 数据库信息未读到或读取失败时为 null（未知）（GLB-01，T10.180）。 */
  unsyncedRecords?: number | null;
  loading?: boolean;
} = {}) {
  const onThemeChange = vi.fn();
  const onRangeChange = vi.fn();
  render(<>
    <AppHeader
      activeTab={activeTab}
      dataScope={dataScope}
      range={range}
      customRange={customRange}
      now={now}
      deviceFilter="all_cloud"
      deviceList={[]}
      cloudStatus={{ configured: true, authenticated: true, email: 'user@example.invalid', userId: 'user-1' }}
      onScopeChange={vi.fn()}
      onCloudScope={vi.fn()}
      onDeviceFilterChange={vi.fn()}
      onRangeChange={onRangeChange}
      showTotalTokens={false}
      onToggleTokenMode={vi.fn()}
      themeMode="auto"
      onThemeChange={onThemeChange}
      onOpenShareCard={vi.fn()}
      dataStatus={{
        loading,
        stale,
        lastRefreshedAt: FIXTURE_REFRESHED_AT,
        unsyncedRecords,
        cloudCapabilityVerified: true,
        cloudFirstSyncCompleted: true,
      }}
    />
    {afterHeader}
  </>);
  return { onThemeChange, onRangeChange };
}

describe('AppHeader', () => {
  it('用量三个子页的顶栏不放范围、口径、设备与战报，这些在页内工具行（T10.276）', () => {
    for (const activeTab of ['dashboard', 'records', 'behavior'] as Tab[]) {
      renderHeader({ activeTab, dataScope: 'cloud' });
      expect(screen.getByRole('group', { name: '数据范围' })).toBeInTheDocument();
      expect(screen.queryByRole('group', { name: '统计时间范围' })).not.toBeInTheDocument();
      expect(screen.queryByRole('group', { name: '概览 Token 口径' })).not.toBeInTheDocument();
      expect(screen.queryByRole('combobox', { name: '云端设备筛选' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: '生成并分享数据战报图片' })).not.toBeInTheDocument();
      cleanup();
    }
  });

  it('活动明细的顶栏保留范围、口径、设备与战报（T10.276 不改其他页）', () => {
    renderHeader({ activeTab: 'logs', dataScope: 'cloud' });
    expect(screen.getByRole('group', { name: '统计时间范围' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: '概览 Token 口径' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: '云端设备筛选' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '生成并分享数据战报图片' })).toBeInTheDocument();
  });

  it('用量三个子页顶栏元素相同，只有面包屑的子页名不同（T10.276、U-101）', () => {
    const crumbs: Record<string, string> = { dashboard: '概览', records: '记录', behavior: '行为分析' };
    const markup = (['dashboard', 'records', 'behavior'] as Tab[]).map((activeTab) => {
      renderHeader({ activeTab, loading: true });
      const header = document.querySelector('header');
      expect(header).toHaveAttribute('data-surface', 'usage');
      const title = header!.querySelector('.toolbar-title');
      expect(title).toHaveTextContent(`用量 · ${crumbs[activeTab]}`);
      // 子页名只给视觉：内容区已用同名作可访问名称，读屏不重复朗读。
      expect(title!.querySelector('.toolbar-title-crumb')).toHaveAttribute('aria-hidden', 'true');
      expect(screen.getByRole('status')).toHaveTextContent('本机数据');
      expect(screen.getByRole('group', { name: '数据范围' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '主题：自动' })).toBeInTheDocument();
      const html = header!.outerHTML.replace(`</span>${crumbs[activeTab]}</span>`, '</span>CRUMB</span>');
      cleanup();
      return html;
    });
    expect(markup[0]).toContain('CRUMB');
    expect(markup[1]).toBe(markup[0]);
    expect(markup[2]).toBe(markup[0]);
  });

  it('非用量页的标题不带面包屑', () => {
    renderHeader({ activeTab: 'logs' });
    expect(document.querySelector('.toolbar-title')).toHaveTextContent(/^活动明细$/);
    expect(document.querySelector('.toolbar-title-crumb')).toBeNull();
  });

  it('主题菜单随焦点离开关闭，内部切换焦点不关闭', async () => {
    renderHeader();
    fireEvent.click(screen.getByRole('button', { name: '主题：自动' }));
    const selected = screen.getByRole('menuitemradio', { name: '自动' });
    await waitFor(() => expect(selected).toHaveFocus());
    screen.getByRole('menuitemradio', { name: '浅色' }).focus();
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.focusIn(screen.getByRole('button', { name: '今日' }));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('日期草稿随焦点离开关闭且不提交，内部编辑不关闭', async () => {
    const { onRangeChange } = renderHeader();
    fireEvent.click(screen.getByRole('button', { name: '自定义日期范围' }));
    const start = screen.getByLabelText('开始日期');
    await waitFor(() => expect(start).toHaveFocus());
    screen.getByLabelText('结束日期').focus();
    expect(start).toBeInTheDocument();
    fireEvent.focusIn(screen.getByRole('button', { name: '今日' }));
    expect(screen.queryByLabelText('开始日期')).not.toBeInTheDocument();
    expect(onRangeChange).not.toHaveBeenCalled();
  });

  it('把主题和日期浮层挂到滚动容器之外，避免被窄窗口裁剪', () => {
    renderHeader({ now: () => new Date(2026, 8, 5, 10, 30) });
    const controls = screen.getByRole('group', { name: '顶部控制器，可横向滚动查看更多命令' });

    fireEvent.click(screen.getByRole('button', { name: '自定义日期范围' }));
    const customDialog = screen.getByRole('dialog', { name: '自定义日期范围' });
    expect(controls).not.toContainElement(customDialog);
    expect(customDialog.parentElement).toBe(document.body);
    fireEvent.mouseDown(customDialog);
    expect(screen.getByRole('dialog', { name: '自定义日期范围' })).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('dialog', { name: '自定义日期范围' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '主题：自动' }));
    const themeMenu = screen.getByRole('menu', { name: '主题模式' });
    expect(controls).not.toContainElement(themeMenu);
    expect(themeMenu.parentElement).toBe(document.body);
  });

  it('把靠近窄窗口右缘的浮层锚定在可视区内', async () => {
    const widthSpy = vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(640);
    renderHeader();
    const trigger = screen.getByRole('button', { name: '主题：自动' });
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({
      bottom: 52,
      height: 32,
      left: 550,
      right: 630,
      top: 20,
      width: 80,
      x: 550,
      y: 20,
      toJSON: () => ({}),
    });

    fireEvent.click(trigger);
    const menu = screen.getByRole('menu', { name: '主题模式' });
    await waitFor(() => {
      expect(menu).toHaveStyle({ left: '466px', top: '60px' });
    });
    widthSpy.mockRestore();
  });

  it('主题菜单按 Tab 退出 Portal，并继续到触发器后的页内控件', async () => {
    renderHeader({ afterHeader: <button type="button">页内下一操作</button> });
    const trigger = screen.getByRole('button', { name: '主题：自动' });
    fireEvent.click(trigger);
    const selected = screen.getByRole('menuitemradio', { name: '自动' });
    await waitFor(() => expect(selected).toHaveFocus());

    fireEvent.keyDown(selected, { key: 'Tab' });

    expect(screen.queryByRole('menu', { name: '主题模式' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '页内下一操作' })).toHaveFocus();

    fireEvent.click(trigger);
    const unselected = screen.getByRole('menuitemradio', { name: '深色' });
    unselected.focus();
    fireEvent.keyDown(unselected, { key: 'Tab', shiftKey: true });
    expect(screen.queryByRole('menu', { name: '主题模式' })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('日期 Portal 只在首末 Tab 边界退出，内部编辑仍保持打开', async () => {
    renderHeader({ now: () => new Date(2026, 8, 5, 10, 30) });
    const trigger = screen.getByRole('button', { name: '自定义日期范围' });
    fireEvent.click(trigger);
    const start = screen.getByLabelText('开始日期');
    await waitFor(() => expect(start).toHaveFocus());

    fireEvent.keyDown(start, { key: 'Tab' });
    expect(screen.getByRole('dialog', { name: '自定义日期范围' })).toBeInTheDocument();

    const first = screen.getByRole('button', { name: '昨天' });
    first.focus();
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(screen.queryByRole('dialog', { name: '自定义日期范围' })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();

    fireEvent.click(trigger);
    const apply = screen.getByRole('button', { name: '应用' });
    apply.focus();
    fireEvent.keyDown(apply, { key: 'Tab' });
    expect(screen.queryByRole('dialog', { name: '自定义日期范围' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '概览有效' })).toHaveFocus();
  });

  it('exposes the data freshness status and an explicit theme menu', () => {
    renderHeader();

    expect(screen.getByRole('status')).toHaveTextContent('本机数据');
    expect(screen.getByRole('status')).toHaveTextContent(`更新于 ${FIXTURE_LOCAL_STAMP}`);
    expect(screen.getByRole('time')).toHaveAttribute('datetime', FIXTURE_REFRESHED_AT);

    fireEvent.click(screen.getByRole('button', { name: '主题：自动' }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(screen.getByRole('menuitemradio', { name: '自动' })).toHaveAttribute('aria-checked', 'true');
  });

  it('shows the timestamp of a stale snapshot instead of implying a fresh update', () => {
    renderHeader({ stale: true });

    expect(screen.getByRole('status')).toHaveTextContent(`最近可信 ${FIXTURE_LOCAL_STAMP}`);
  });

  it('labels a cloud snapshot timestamp as a data cutoff, not a sync completion time', () => {
    renderHeader({ dataScope: 'cloud' });

    expect(screen.getByRole('status')).toHaveTextContent(`数据截至 ${FIXTURE_LOCAL_STAMP}`);
    expect(screen.getByRole('status')).not.toHaveTextContent('更新于');
  });

  it('云端待上传数未知（数据库信息未读到或读取失败）时显示「待上传数未知」并用警示色调，不当作 0（GLB-01，T10.180）', () => {
    renderHeader({ dataScope: 'cloud', unsyncedRecords: null });

    expect(screen.getByRole('status')).toHaveTextContent('待上传数未知');
    expect(screen.getByRole('status')).not.toHaveTextContent('0 条待上传');
    expect(document.querySelector('.toolbar-health')?.className).toContain('is-warning');
  });

  it('本机数据视角下待上传数未知不强制警示色调，也不显示云端专属文案（T10.180）', () => {
    renderHeader({ dataScope: 'local', unsyncedRecords: null });

    expect(screen.getByRole('status')).not.toHaveTextContent('待上传数未知');
    expect(document.querySelector('.toolbar-health')?.className).toContain('is-ready');
  });

  it('keeps unknown freshness copy scoped to the selected data source', () => {
    expect(formatHeaderFreshnessLabel('local', null, null)).toBe('刷新时间未知');
    expect(formatHeaderFreshnessLabel('cloud', null, null)).toBe('数据时间未知');
  });

  it('副标题只留标题给不出的信息：登录后的邮箱保留，看板的自我描述删掉', () => {
    renderHeader({ activeTab: 'dashboard' });
    // 数据范围分段控件已经说了本机/云端，副标题再写一句「仅此电脑的使用记录」
    // 只是把它换句话重复。登录邮箱是标题里没有的，留下。
    expect(screen.getByText('用量')).toHaveClass('toolbar-title-parent');
    expect(screen.queryByText('仅此电脑的使用记录')).not.toBeInTheDocument();
    expect(screen.getByText('user@example.invalid')).toBeInTheDocument();
  });

  it('switches the shell to a settings context and removes dashboard-only controls', () => {
    renderHeader({ activeTab: 'settings' });

    expect(screen.getByText('设置与云端')).toBeInTheDocument();
    // T10.126：副标题「连接、额度、壁纸与数据管理」和页内「系统设置 / 常用偏好、账户与
    // 数据管理。」把同一件事写了四行；数据新鲜度胶囊说的是看板读到的那份数据，设置页没有这回事。
    expect(screen.queryByText('连接、额度、壁纸与数据管理')).not.toBeInTheDocument();
    expect(document.querySelector('.toolbar-subtitle')).toBeNull();
    expect(document.querySelector('.toolbar-health')).toBeNull();
    expect(screen.queryByRole('group', { name: '数据范围' })).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: '统计时间范围' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '生成并分享数据战报图片' })).not.toBeInTheDocument();
    expect(screen.getByRole('group', { name: '主题设置' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '主题：自动' })).toBeInTheDocument();
  });

  it('announces the phone toolbar as scrollable and hides the cue at the end', () => {
    renderHeader();
    const controls = screen.getByRole('group', { name: '顶部控制器，可横向滚动查看更多命令' });
    const cue = document.querySelector<HTMLButtonElement>('.header-controls-scroll-cue');
    expect(cue).not.toBeNull();
    expect(cue).not.toHaveClass('is-visible');
    expect(cue).toHaveAttribute('aria-hidden', 'true');
    expect(cue).toHaveAttribute('tabindex', '-1');

    Object.defineProperties(controls, {
      clientWidth: { configurable: true, value: 120 },
      scrollWidth: { configurable: true, value: 260 },
      scrollLeft: { configurable: true, value: 0, writable: true },
    });
    fireEvent.scroll(controls);
    expect(cue).toHaveClass('is-visible');
    expect(cue).toHaveAttribute('aria-hidden', 'false');
    expect(cue).toHaveAttribute('tabindex', '0');

    Object.defineProperty(controls, 'scrollLeft', { configurable: true, value: 140, writable: true });
    fireEvent.scroll(controls);
    expect(cue).not.toHaveClass('is-visible');
    expect(cue).toHaveAttribute('aria-hidden', 'true');
    expect(cue).toHaveAttribute('tabindex', '-1');
  });

  it('moves the phone toolbar forward from the visible scroll cue', () => {
    renderHeader();
    const controls = screen.getByRole('group', { name: '顶部控制器，可横向滚动查看更多命令' });
    const cue = document.querySelector<HTMLButtonElement>('.header-controls-scroll-cue');
    expect(cue).not.toBeNull();
    const scrollTo = vi.fn();

    Object.defineProperties(controls, {
      clientWidth: { configurable: true, value: 200 },
      scrollWidth: { configurable: true, value: 600 },
      scrollLeft: { configurable: true, value: 0, writable: true },
      scrollTo: { configurable: true, value: scrollTo },
    });
    fireEvent.scroll(controls);
    fireEvent.click(cue!);

    expect(scrollTo).toHaveBeenCalledWith({ left: 160, behavior: 'smooth' });
  });

  it('activates the phone toolbar scroll cue with Enter and Space', () => {
    renderHeader();
    const controls = screen.getByRole('group', { name: '顶部控制器，可横向滚动查看更多命令' });
    const cue = document.querySelector<HTMLButtonElement>('.header-controls-scroll-cue');
    expect(cue).not.toBeNull();
    const scrollTo = vi.fn();

    Object.defineProperties(controls, {
      clientWidth: { configurable: true, value: 200 },
      scrollWidth: { configurable: true, value: 600 },
      scrollLeft: { configurable: true, value: 0, writable: true },
      scrollTo: { configurable: true, value: scrollTo },
    });
    fireEvent.scroll(controls);
    fireEvent.keyDown(cue!, { key: 'Enter' });
    fireEvent.keyDown(cue!, { key: ' ' });

    expect(scrollTo).toHaveBeenCalledTimes(2);
  });

  it('moves through theme options with arrows and returns focus on Escape', async () => {
    renderHeader();
    const trigger = screen.getByRole('button', { name: '主题：自动' });

    fireEvent.click(trigger);
    const selected = screen.getByRole('menuitemradio', { name: '自动' });
    await waitFor(() => expect(selected).toHaveFocus());
    fireEvent.keyDown(selected, { key: 'ArrowDown' });
    const light = screen.getByRole('menuitemradio', { name: '浅色' });
    expect(light).toHaveFocus();
    fireEvent.keyDown(light, { key: 'End' });
    const dark = screen.getByRole('menuitemradio', { name: '深色' });
    expect(dark).toHaveFocus();
    fireEvent.keyDown(dark, { key: 'Home' });
    expect(selected).toHaveFocus();
    fireEvent.keyDown(selected, { key: 'Escape' });

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('selecting a theme notifies the parent and returns focus to the trigger', async () => {
    const { onThemeChange } = renderHeader();
    const trigger = screen.getByRole('button', { name: '主题：自动' });

    fireEvent.click(trigger);
    const selected = screen.getByRole('menuitemradio', { name: '自动' });
    await waitFor(() => expect(selected).toHaveFocus());
    fireEvent.click(screen.getByRole('menuitemradio', { name: '浅色' }));

    expect(onThemeChange).toHaveBeenCalledWith('light');
    expect(trigger).toHaveFocus();
  });

  it('pointer theme selection restores leading context after horizontal scrolling', async () => {
    renderHeader();
    const controls = screen.getByRole('group', { name: '顶部控制器，可横向滚动查看更多命令' });
    const trigger = screen.getByRole('button', { name: '主题：自动' });
    const scrollTo = vi.fn();
    Object.defineProperties(controls, {
      clientWidth: { configurable: true, value: 200 },
      scrollWidth: { configurable: true, value: 600 },
      scrollLeft: { configurable: true, value: 320, writable: true },
      scrollTo: { configurable: true, value: scrollTo },
    });

    fireEvent.click(trigger);
    const selected = screen.getByRole('menuitemradio', { name: '自动' });
    await waitFor(() => expect(selected).toHaveFocus());
    fireEvent.click(screen.getByRole('menuitemradio', { name: '浅色' }), { detail: 1 });

    await waitFor(() => expect(scrollTo).toHaveBeenCalledWith({ left: 0, behavior: 'auto' }));
    expect(trigger).toHaveFocus();
  });

  it('opens the custom range dialog and applies typed dates as an inclusive range', () => {
    const { onRangeChange } = renderHeader({ now: () => new Date(2026, 8, 5, 10, 30) });

    fireEvent.click(screen.getByRole('button', { name: '自定义日期范围' }));
    expect(screen.getByRole('dialog', { name: '自定义日期范围' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('开始日期'), { target: { value: '2026-08-01' } });
    fireEvent.change(screen.getByLabelText('结束日期'), { target: { value: '2026-08-31' } });
    fireEvent.click(screen.getByRole('button', { name: '应用' }));

    expect(onRangeChange).toHaveBeenCalledWith('custom', { start: '2026-08-01', end: '2026-08-31' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('rejects an inverted or oversized range without changing the selection', () => {
    const { onRangeChange } = renderHeader({ now: () => new Date(2026, 8, 5, 10, 30) });

    fireEvent.click(screen.getByRole('button', { name: '自定义日期范围' }));
    fireEvent.change(screen.getByLabelText('开始日期'), { target: { value: '2026-08-31' } });
    fireEvent.change(screen.getByLabelText('结束日期'), { target: { value: '2026-08-01' } });
    fireEvent.click(screen.getByRole('button', { name: '应用' }));
    expect(screen.getByRole('alert')).toHaveTextContent('开始日期不能晚于结束日期');

    fireEvent.change(screen.getByLabelText('开始日期'), { target: { value: '2024-01-01' } });
    fireEvent.change(screen.getByLabelText('结束日期'), { target: { value: '2026-09-05' } });
    fireEvent.click(screen.getByRole('button', { name: '应用' }));
    expect(screen.getByRole('alert')).toHaveTextContent('最多支持 731 天');
    expect(onRangeChange).not.toHaveBeenCalled();
  });

  it('resolves presets from the injected today on the local calendar', () => {
    const { onRangeChange } = renderHeader({ now: () => new Date(2026, 8, 5, 10, 30) });

    fireEvent.click(screen.getByRole('button', { name: '自定义日期范围' }));
    fireEvent.click(screen.getByRole('button', { name: '上月' }));
    expect(onRangeChange).toHaveBeenLastCalledWith('custom', { start: '2026-08-01', end: '2026-08-31' });

    fireEvent.click(screen.getByRole('button', { name: '自定义日期范围' }));
    fireEvent.click(screen.getByRole('button', { name: '上周' }));
    expect(onRangeChange).toHaveBeenLastCalledWith('custom', { start: '2026-08-24', end: '2026-08-30' });

    fireEvent.click(screen.getByRole('button', { name: '自定义日期范围' }));
    fireEvent.click(screen.getByRole('button', { name: '上季度' }));
    expect(onRangeChange).toHaveBeenLastCalledWith('custom', { start: '2026-04-01', end: '2026-06-30' });
  });

  it('shows the applied bounds on the range trigger and closes with Escape', () => {
    renderHeader({ range: 'custom', customRange: { start: '2026-08-01', end: '2026-08-31' } });

    const trigger = screen.getByRole('button', { name: '自定义范围：8月1日—8月31日' });
    expect(trigger).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '本月' })).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(trigger);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('displays zero-cache mode tooltip on token switcher when cachedTokens is 0', () => {
    const onToggle = vi.fn();
    render(
      <AppHeader
        activeTab="logs"
        dataScope="local"
        range="today"
        deviceFilter="all_cloud"
        deviceList={[]}
        cloudStatus={{ configured: true, authenticated: true, email: 'user@example.invalid', userId: 'user-1' }}
        onScopeChange={vi.fn()}
        onCloudScope={vi.fn()}
        onDeviceFilterChange={vi.fn()}
        onRangeChange={vi.fn()}
        showTotalTokens={false}
        onToggleTokenMode={onToggle}
        cachedTokens={0}
        themeMode="auto"
        onThemeChange={vi.fn()}
        dataStatus={{
          loading: false,
          stale: false,
          lastRefreshedAt: FIXTURE_REFRESHED_AT,
          unsyncedRecords: 0,
          cloudCapabilityVerified: true,
          cloudFirstSyncCompleted: true,
        }}
      />,
    );

    const effectiveBtn = screen.getByRole('button', { name: '概览有效' });
    const cachedBtn = screen.getByRole('button', { name: '概览含缓存' });

    expect(effectiveBtn).toHaveAttribute('title', '当前周期未记录到缓存 Token；概览指标使用输入 + 输出 Token');
    expect(cachedBtn).toHaveAttribute('title', '当前周期未记录到缓存 Token，概览有效与含缓存数值相同');
  });
});
