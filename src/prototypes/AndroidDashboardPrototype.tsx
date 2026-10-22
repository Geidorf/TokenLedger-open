import {
  ArrowLeft,
  BarChart3,
  BatteryMedium,
  CalendarDays,
  ChevronRight,
  CircleGauge,
  Filter,
  Gauge,
  LayoutDashboard,
  ListTree,
  MonitorSmartphone,
  MoonStar,
  RefreshCw,
  RotateCw,
  Settings2,
  Sparkles,
  SunMedium,
  Wifi,
  X,
  Share2,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from 'react';
import type { EChartsCoreOption } from 'echarts/core';
import { EChart as SharedEChart } from '../components/EChart';
import './android-dashboard-prototype.css';

type PrototypeTab = 'overview' | 'insights' | 'quota' | 'widget' | 'settings';
type PrototypeRange = '今日' | '本周' | '本月' | '今年' | '总计';
type InsightMode = '趋势' | '来源' | '日历' | '明细';
type WidgetMode = 'polished' | 'eink';
type PrototypeTokenMode = 'effective' | 'all';

type PrototypeWakeLockSentinel = {
  release: () => Promise<void>;
  addEventListener: (type: 'release', listener: () => void, options?: { once?: boolean }) => void;
};

const FORCE_LANDSCAPE_STORAGE_KEY = 'tokenledger:prototype-force-landscape';

function EChart(props: ComponentProps<typeof SharedEChart>) {
  return <SharedEChart {...props} runtime="prototype" />;
}

type RangeFixture = {
  tokens: string;
  delta: string;
  cost: string;
  requests: string;
  cache: string;
  cacheHit: string;
  average: string;
  input: string;
  output: string;
  current: number[];
  previous: number[];
  /**
   * X 轴刻度。此前趋势图写死 `xAxis.show = false`——图上一个时间刻度都没有，
   * 「峰值位于 10:00」这类结论在图上根本无法定位。
   */
  axisLabels: string[];
};

const RANGE_FIXTURES: Record<PrototypeRange, RangeFixture> = {
  今日: {
    tokens: '1.28M', delta: '+12.4%', cost: '¥132.46', requests: '3,127', cache: '216K', cacheHit: '48%', average: '409', input: '1.04M', output: '241K',
    current: [14, 22, 20, 31, 27, 41, 36, 49, 46, 55, 53, 58], previous: [10, 17, 23, 22, 28, 32, 30, 38, 35, 41, 39, 44],
    axisLabels: ['00:00', '02:00', '04:00', '06:00', '08:00', '10:00', '12:00', '14:00', '16:00', '18:00', '20:00', '22:00'],
  },
  本周: {
    tokens: '7.84M', delta: '+8.1%', cost: '¥768.20', requests: '18,420', cache: '1.43M', cacheHit: '52%', average: '426', input: '6.31M', output: '1.53M',
    current: [35, 43, 48, 52, 58, 63, 71], previous: [31, 39, 45, 50, 51, 58, 64],
    axisLabels: ['周一', '周二', '周三', '周四', '周五', '周六', '周日'],
  },
  本月: {
    tokens: '32.6M', delta: '-3.2%', cost: '¥3,086', requests: '76,902', cache: '5.91M', cacheHit: '49%', average: '424', input: '26.8M', output: '5.8M',
    current: [39, 44, 51, 48, 57, 61, 67, 64, 72, 75], previous: [36, 41, 46, 52, 56, 60, 63, 69, 73, 78],
    axisLabels: ['1 日', '4 日', '7 日', '10 日', '13 日', '16 日', '19 日', '22 日', '25 日', '28 日'],
  },
  今年: {
    tokens: '284M', delta: '+21.7%', cost: '¥26,940', requests: '681K', cache: '48.2M', cacheHit: '46%', average: '417', input: '231M', output: '53M',
    current: [26, 31, 38, 43, 51, 59, 65, 72, 81, 88, 94, 103], previous: [21, 27, 33, 37, 44, 49, 55, 62, 69, 75, 82, 86],
    axisLabels: ['1 月', '2 月', '3 月', '4 月', '5 月', '6 月', '7 月', '8 月', '9 月', '10 月', '11 月', '12 月'],
  },
  总计: {
    tokens: '618M', delta: '累计', cost: '¥58,412', requests: '1.48M', cache: '106M', cacheHit: '47%', average: '418', input: '502M', output: '116M',
    current: [18, 24, 31, 38, 47, 55, 68, 78, 91, 103, 119, 136], previous: [14, 20, 26, 32, 39, 47, 56, 66, 78, 89, 101, 115],
    axisLabels: ['第 1 段', '第 2 段', '第 3 段', '第 4 段', '第 5 段', '第 6 段', '第 7 段', '第 8 段', '第 9 段', '第 10 段', '第 11 段', '第 12 段'],
  },
};

const SOURCE_DATA = [
  { name: 'Codex CLI', value: '612K', percent: 48, color: '#6d96ff', models: 'GPT-5.4 · 6 个模型' },
  { name: 'Claude Code', value: '441K', percent: 34, color: '#c19cff', models: 'Sonnet 4.5 · 3 个模型' },
  { name: 'Cursor', value: '227K', percent: 18, color: '#65d6b0', models: 'Auto · 4 个模型' },
] as const;

const QUOTA_PROVIDERS = [
  {
    name: 'Claude', tone: 'violet', caption: 'Max 订阅 · 桌面端同步', source: 'CodexBar 增强读取',
    windows: [
      { label: '5 小时窗口', used: 28, reset: '2 小时 20 分后重置' },
      { label: '7 天窗口', used: 48, reset: '周一 00:00 重置' },
    ],
  },
  {
    name: 'Codex', tone: 'blue', caption: 'ChatGPT Pro · 本地读取', source: '官方 app-server',
    windows: [
      { label: '5 小时窗口', used: 43, reset: '2 小时 20 分后重置' },
      { label: '7 天窗口', used: 62, reset: '周一 00:00 重置' },
    ],
  },
] as const;

const HEATMAP_VALUES = Array.from({ length: 84 }, (_, index) => {
  const week = Math.floor(index / 7);
  const day = index % 7;
  const value = (week * 19 + day * 11 + (week % 3) * 13) % 92;
  return [week, day, value];
});

const NAV_ITEMS: Array<{ id: Exclude<PrototypeTab, 'settings'>; label: string; icon: typeof Gauge }> = [
  { id: 'overview', label: '概览', icon: LayoutDashboard },
  { id: 'insights', label: '洞察', icon: BarChart3 },
  { id: 'quota', label: '额度', icon: CircleGauge },
  { id: 'widget', label: '摆件', icon: MonitorSmartphone },
];

function makeTrendOption(fixture: RangeFixture, monochrome = false): EChartsCoreOption {
  const current = monochrome ? '#111' : '#6d96ff';
  const previous = monochrome ? '#777' : 'rgba(190,190,199,.58)';
  return {
    animationDuration: monochrome ? 0 : 260,
    // 给刻度留出行高。此前 bottom: 2 且 xAxis.show = false，图上没有任何时间
    // 参照，正下方结论里的「峰值位于 10:00」在图上无法定位。
    grid: { left: 3, right: 3, top: 10, bottom: 18 },
    xAxis: {
      type: 'category',
      boundaryGap: false,
      data: fixture.axisLabels,
      axisLine: { lineStyle: { color: monochrome ? '#999' : 'rgba(255,255,255,.14)' } },
      axisTick: { show: false },
      axisLabel: {
        color: monochrome ? '#555' : 'rgba(255,255,255,.5)',
        fontSize: 10,
        margin: 8,
        // 手机宽度放不下 12 个刻度：只留首、中、末三个锚点，够定位又不糊成一片。
        interval: (index: number, _value: string) => {
          const last = fixture.axisLabels.length - 1;
          return index === 0 || index === last || index === Math.floor(last / 2);
        },
        align: 'center',
      },
    },
    yAxis: { type: 'value', show: false, min: 0 },
    tooltip: { trigger: 'axis', backgroundColor: monochrome ? '#fff' : '#29292d', borderColor: monochrome ? '#111' : '#3d3d43', textStyle: { color: monochrome ? '#111' : '#fff' } },
    series: [
      { type: 'line', data: fixture.previous, smooth: 0.34, symbol: 'none', lineStyle: { width: 1.5, color: previous, type: 'dashed' } },
      { type: 'line', data: fixture.current, smooth: 0.34, symbol: 'none', lineStyle: { width: 2.6, color: current }, areaStyle: { color: monochrome ? 'rgba(0,0,0,.06)' : 'rgba(109,150,255,.15)' } },
    ],
  };
}

function makeSourceOption(monochrome = false): EChartsCoreOption {
  return {
    animationDuration: monochrome ? 0 : 260,
    tooltip: { trigger: 'item', backgroundColor: monochrome ? '#fff' : '#29292d', borderColor: monochrome ? '#111' : '#3d3d43', textStyle: { color: monochrome ? '#111' : '#fff' } },
    series: [{
      type: 'pie', radius: ['58%', '78%'], center: ['50%', '50%'], silent: false,
      itemStyle: { borderWidth: 3, borderColor: monochrome ? '#fff' : '#1c1c1f' },
      label: { show: false },
      data: SOURCE_DATA.map((item, index) => ({ value: item.percent, name: item.name, itemStyle: { color: monochrome ? ['#111', '#777', '#c8c8c8'][index] : item.color } })),
    }],
  };
}

function makeCompositionOption(fixture: RangeFixture): EChartsCoreOption {
  return {
    animationDuration: 260,
    grid: { left: 2, right: 2, top: 6, bottom: 3 },
    xAxis: { type: 'value', show: false, max: 100 },
    yAxis: { type: 'category', show: false, data: ['tokens'] },
    tooltip: { trigger: 'item', backgroundColor: '#29292d', borderColor: '#3d3d43', textStyle: { color: '#fff' } },
    series: [
      { name: `输入 ${fixture.input}`, type: 'bar', stack: 'total', data: [82], barWidth: 9, itemStyle: { color: '#6d96ff', borderRadius: [5, 0, 0, 5] } },
      { name: `输出 ${fixture.output}`, type: 'bar', stack: 'total', data: [18], barWidth: 9, itemStyle: { color: '#65d6b0', borderRadius: [0, 5, 5, 0] } },
    ],
  };
}

function makeHeatmapOption(monochrome = false): EChartsCoreOption {
  return {
    animationDuration: monochrome ? 0 : 220,
    grid: { left: 18, right: 1, top: 3, bottom: 14 },
    xAxis: { type: 'category', data: Array.from({ length: 12 }, (_, index) => `${index + 1}`), axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: monochrome ? '#555' : '#777780', fontSize: 8, interval: 2 } },
    yAxis: { type: 'category', data: ['一', '二', '三', '四', '五', '六', '日'], axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: monochrome ? '#555' : '#777780', fontSize: 8 } },
    visualMap: { show: false, min: 0, max: 92, inRange: { color: monochrome ? ['#f2f2f2', '#111'] : ['#24252a', '#385c9b', '#76a0ff'] } },
    tooltip: { formatter: (params: { value?: number[] }) => `第 ${(params.value?.[0] ?? 0) + 1} 周 · ${(params.value?.[2] ?? 0)}K Token`, backgroundColor: monochrome ? '#fff' : '#29292d', borderColor: monochrome ? '#111' : '#3d3d43', textStyle: { color: monochrome ? '#111' : '#fff' } },
    series: [{ type: 'heatmap', data: HEATMAP_VALUES, itemStyle: { borderWidth: 2, borderColor: monochrome ? '#fff' : '#171719', borderRadius: 2 }, emphasis: { disabled: monochrome } }],
  };
}

function makeAmbientTrendOption(fixture: RangeFixture, monochrome = false): EChartsCoreOption {
  const accent = monochrome ? '#111' : '#6d96ff';
  const previous = monochrome ? '#666' : 'rgba(190,190,199,.62)';
  return {
    animationDuration: monochrome ? 0 : 260,
    grid: { left: 2, right: 70, top: 12, bottom: 8 },
    xAxis: { type: 'category', show: false, boundaryGap: false, data: fixture.current.map((_, index) => index) },
    yAxis: { type: 'value', show: false, min: 0 },
    tooltip: { trigger: 'axis', backgroundColor: monochrome ? '#fff' : '#202126', borderColor: monochrome ? '#111' : '#383940', textStyle: { color: monochrome ? '#111' : '#fff' } },
    series: [
      {
        name: '上周同期', type: 'line', data: fixture.previous, smooth: 0.38, symbol: 'none',
        lineStyle: { width: 1.35, color: previous, type: 'dashed' },
        endLabel: { show: true, color: previous, fontSize: 9, formatter: '上周 1.14M' },
        labelLayout: { moveOverlap: 'shiftY' },
      },
      {
        name: '当前周期', type: 'line', data: fixture.current, smooth: 0.38, symbol: 'none',
        lineStyle: { width: 2.2, color: accent },
        areaStyle: { color: monochrome ? 'rgba(0,0,0,.035)' : 'rgba(109,150,255,.10)' },
        endLabel: { show: true, color: monochrome ? '#111' : '#f5f5f7', fontSize: 10, fontWeight: 700, formatter: `${fixture.tokens}\n当前周期` },
        labelLayout: { moveOverlap: 'shiftY' },
      },
    ],
  };
}

function makeQuotaOrbitOption(remaining: number, monochrome = false): EChartsCoreOption {
  const accent = monochrome ? '#111' : '#6d96ff';
  const track = monochrome ? '#d0d0d0' : '#303138';
  return {
    animationDuration: monochrome ? 0 : 260,
    series: [{
      type: 'pie',
      center: ['50%', '50%'],
      radius: ['72%', '82%'],
      startAngle: 112,
      clockwise: true,
      silent: true,
      label: { show: false },
      data: [
        { value: remaining, itemStyle: { color: accent, borderRadius: 4 } },
        { value: 100 - remaining, itemStyle: { color: track } },
        { value: 58, itemStyle: { color: 'transparent' } },
      ],
    }],
  };
}

export function AndroidDashboardPrototype() {
  const [tab, setTab] = useState<PrototypeTab>('overview');
  const [range, setRange] = useState<PrototypeRange>('今日');
  const [insightMode, setInsightMode] = useState<InsightMode>('趋势');
  const [widgetMode, setWidgetMode] = useState<WidgetMode>('polished');
  const [widgetTokenMode, setWidgetTokenMode] = useState<PrototypeTokenMode>('effective');
  const [fullScreenWidget, setFullScreenWidget] = useState(() => {
    if (typeof window === 'undefined') return false;
    return new URLSearchParams(window.location.search).get('widget') === 'fullscreen';
  });
  const [wakeLockActive, setWakeLockActive] = useState(false);
  const wakeLockRef = useRef<PrototypeWakeLockSentinel | null>(null);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const [machine, setMachine] = useState('全部设备');
  const [actionStatus, setActionStatus] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const actionStatusTimerRef = useRef<number | null>(null);
  const [forceLandscape, setForceLandscape] = useState(() => {
    if (typeof window === 'undefined') return false;
    try {
      return window.localStorage.getItem(FORCE_LANDSCAPE_STORAGE_KEY) === 'true';
    } catch {
      return false;
    }
  });
  const fixture = RANGE_FIXTURES[range];
  const trendOption = useMemo(() => makeTrendOption(fixture), [fixture]);
  const sourceOption = useMemo(() => makeSourceOption(), []);
  const compositionOption = useMemo(() => makeCompositionOption(fixture), [fixture]);
  const heatmapOption = useMemo(() => makeHeatmapOption(), []);
  const ambientTrend = useMemo(() => makeAmbientTrendOption(fixture), [fixture]);
  const claudeOrbit = useMemo(() => makeQuotaOrbitOption(72), []);
  const codexOrbit = useMemo(() => makeQuotaOrbitOption(57), []);

  const releaseWakeLock = useCallback(async () => {
    const sentinel = wakeLockRef.current;
    wakeLockRef.current = null;
    setWakeLockActive(false);
    if (sentinel) await sentinel.release().catch(() => undefined);
  }, []);

  const requestWakeLock = useCallback(async () => {
    if (wakeLockRef.current || document.visibilityState !== 'visible') return;
    const wakeLock = (navigator as Navigator & {
      wakeLock?: { request: (type: 'screen') => Promise<PrototypeWakeLockSentinel> };
    }).wakeLock;
    if (!wakeLock) return;
    try {
      const sentinel = await wakeLock.request('screen');
      wakeLockRef.current = sentinel;
      setWakeLockActive(true);
      sentinel.addEventListener('release', () => {
        if (wakeLockRef.current === sentinel) wakeLockRef.current = null;
        setWakeLockActive(false);
      }, { once: true });
    } catch {
      setWakeLockActive(false);
    }
  }, []);

  const openFullScreenWidget = useCallback(() => {
    setFullScreenWidget(true);
    void requestWakeLock();
  }, [requestWakeLock]);

  const closeFullScreenWidget = useCallback(() => {
    setFullScreenWidget(false);
    void releaseWakeLock();
  }, [releaseWakeLock]);

  useEffect(() => {
    try {
      window.localStorage.setItem(FORCE_LANDSCAPE_STORAGE_KEY, String(forceLandscape));
    } catch {
      // The prototype remains interactive when storage is unavailable.
    }
  }, [forceLandscape]);

  useEffect(() => {
    scrollAreaRef.current?.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  }, [tab]);

  useEffect(() => {
    if (!fullScreenWidget) return undefined;
    void requestWakeLock();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeFullScreenWidget();
    };
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') void requestWakeLock();
    };
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('visibilitychange', handleVisibility);
      void releaseWakeLock();
    };
  }, [closeFullScreenWidget, fullScreenWidget, releaseWakeLock, requestWakeLock]);

  const openInsight = (mode: InsightMode) => {
    setInsightMode(mode);
    setTab('insights');
  };

  const announceAction = useCallback((message: string) => {
    setActionStatus(message);
    if (actionStatusTimerRef.current !== null) window.clearTimeout(actionStatusTimerRef.current);
    actionStatusTimerRef.current = window.setTimeout(() => {
      setActionStatus('');
      actionStatusTimerRef.current = null;
    }, 3200);
  }, []);

  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    window.setTimeout(() => {
      setRefreshing(false);
      announceAction('演示数据已更新');
    }, 450);
  }, [announceAction]);

  const handleShare = useCallback(async () => {
    const report = `TokenLedger ${range}数据战报：有效 Token ${fixture.tokens}，预估费用 ${fixture.cost}，请求 ${fixture.requests}。`;
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({ title: 'TokenLedger 数据战报', text: report });
        announceAction('已打开系统分享');
        return;
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return;
      }
    }
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard-unavailable');
      await navigator.clipboard.writeText(report);
      announceAction('战报已复制到剪贴板');
    } catch {
      announceAction('当前环境暂不支持分享');
    }
  }, [announceAction, fixture, range]);

  useEffect(() => () => {
    if (actionStatusTimerRef.current !== null) window.clearTimeout(actionStatusTimerRef.current);
  }, []);

  if (fullScreenWidget) {
    return (
      <AmbientWidgetScreen
        fixture={fixture}
        mode={widgetMode}
        tokenMode={widgetTokenMode}
        wakeLockActive={wakeLockActive}
        trendOption={ambientTrend}
        heatmapOption={heatmapOption}
        claudeOrbit={claudeOrbit}
        codexOrbit={codexOrbit}
        onToggleTokenMode={() => setWidgetTokenMode((current) => current === 'effective' ? 'all' : 'effective')}
      />
    );
  }

  return (
    <main className="android-prototype-stage">
      <section className="prototype-notes" aria-label="原型说明">
        <span className="prototype-kicker">Android dashboard · second pass</span>
        <h1>高密度，<br />但不嘈杂。</h1>
        <p>沿用旧版全面的数据结构，重新组织成可扫描、可下钻、适合长期摆放的移动看板。</p>
        <ol>
          <li><strong>完整看板</strong><span>趋势、构成、工具分布、额度与活跃日历全部回到主路径。</span></li>
          <li><strong>四类洞察</strong><span>趋势、来源、日历和明细在同一层切换，保留筛选上下文。</span></li>
          <li><strong>双摆件</strong><span>精美模式强调阅读层次；E-ink 模式静态、单色、低刷新。</span></li>
          <li><strong>真实跳转</strong><span>卡片、来源行、热力图和底部导航都进入对应页面。</span></li>
        </ol>
      </section>

      <section
        className={`prototype-device ${forceLandscape ? 'is-landscape-locked' : ''} ${tab === 'settings' ? 'is-settings' : ''}`}
        aria-label="TokenLedger Android 看板交互原型"
        data-orientation={forceLandscape ? 'landscape' : 'system'}
      >
        <div className="prototype-statusbar" aria-hidden="true">
          <span>9:41</span>
          <span><Wifi size={12} /><BatteryMedium size={14} /></span>
        </div>
        <header className="prototype-appbar">
          <div>
            <span className="prototype-eyebrow">TOKENLEDGER</span>
            <h2>{tab === 'insights' ? '洞察' : tab === 'widget' ? '摆件' : tab === 'settings' ? '设置' : tab === 'quota' ? '额度' : '概览'}</h2>
          </div>
          <div className="prototype-appbar-actions">
            {tab === 'settings' ? (
              <button className="prototype-icon-button" type="button" aria-label="返回概览" onClick={() => setTab('overview')}><ArrowLeft size={18} /></button>
            ) : (
              <>
                <button className="prototype-icon-button" type="button" aria-label="分享数据战报" onClick={handleShare}><Share2 size={18} /></button>
                <button className={`prototype-icon-button ${refreshing ? 'is-refreshing' : ''}`} type="button" aria-label={refreshing ? '刷新数据中' : '刷新数据'} disabled={refreshing} onClick={handleRefresh}><RefreshCw size={18} /></button>
                <button className="prototype-icon-button" type="button" aria-label="打开设置" onClick={() => setTab('settings')}><Settings2 size={18} /></button>
              </>
            )}
          </div>
        </header>

        <div ref={scrollAreaRef} className="prototype-scroll-area">
          {actionStatus && <div className="prototype-action-status" role="status" aria-live="polite">{actionStatus}</div>}
          {tab === 'overview' && (
            <OverviewPage
              range={range}
              setRange={setRange}
              machine={machine}
              fixture={fixture}
              trendOption={trendOption}
              sourceOption={sourceOption}
              compositionOption={compositionOption}
              heatmapOption={heatmapOption}
              onFilter={() => setFilterOpen(true)}
              onOpenQuota={() => setTab('quota')}
              onOpenInsight={openInsight}
            />
          )}
          {tab === 'insights' && (
            <InsightsPage
              mode={insightMode}
              setMode={setInsightMode}
              range={range}
              fixture={fixture}
              trendOption={trendOption}
              sourceOption={sourceOption}
              heatmapOption={heatmapOption}
            />
          )}
          {tab === 'quota' && <QuotaPage />}
          {tab === 'widget' && (
            <WidgetPage
              mode={widgetMode}
              setMode={setWidgetMode}
              fixture={fixture}
              trendOption={trendOption}
              heatmapOption={heatmapOption}
              onOpenFullscreen={openFullScreenWidget}
            />
          )}
          {tab === 'settings' && <SettingsPage forceLandscape={forceLandscape} onForceLandscapeChange={setForceLandscape} />}
        </div>

        {tab !== 'settings' && (
          <nav className="prototype-tabbar" aria-label="主导航">
            {NAV_ITEMS.map(({ id, label, icon: Icon }) => (
              <button key={id} type="button" className={tab === id ? 'is-active' : ''} aria-current={tab === id ? 'page' : undefined} onClick={() => setTab(id)}>
                <Icon size={20} strokeWidth={tab === id ? 2.5 : 2} />
                <span>{label}</span>
              </button>
            ))}
          </nav>
        )}

        {filterOpen && <FilterSheet machine={machine} onSelect={setMachine} onClose={() => setFilterOpen(false)} />}
      </section>
    </main>
  );
}

function OverviewPage({
  range, setRange, machine, fixture, trendOption, sourceOption, compositionOption, heatmapOption, onFilter, onOpenQuota, onOpenInsight,
}: {
  range: PrototypeRange;
  setRange: (range: PrototypeRange) => void;
  machine: string;
  fixture: RangeFixture;
  trendOption: EChartsCoreOption;
  sourceOption: EChartsCoreOption;
  compositionOption: EChartsCoreOption;
  heatmapOption: EChartsCoreOption;
  onFilter: () => void;
  onOpenQuota: () => void;
  onOpenInsight: (mode: InsightMode) => void;
}) {
  return (
    <>
      <div className="prototype-control-stack">
        <RangeSelector range={range} setRange={setRange} />
        <button className="prototype-filter-button" type="button" onClick={onFilter}><Filter size={16} /><span title={machine}>{machine}</span><em>筛选</em></button>
      </div>

      <section className="prototype-card prototype-hero-card">
        <div className="prototype-card-label"><span>有效 Token</span><small>输入 + 输出</small></div>
        <div className="prototype-hero-head">
          <div className="prototype-hero-value"><strong>{fixture.tokens}</strong><span>{fixture.delta}</span></div>
          <div className="prototype-cost"><span>预估费用</span><strong>{fixture.cost}</strong></div>
        </div>
        <div className="prototype-chart"><EChart option={trendOption} ariaLabel={`${range} Token 同期趋势`} /></div>
        <div className="prototype-metric-row">
          <Metric label="请求次数" value={fixture.requests} />
          <Metric label="缓存读取占比" value={fixture.cacheHit} />
          <Metric label="Token / 次" value={fixture.average} />
        </div>
        <button type="button" className="prototype-card-link" onClick={() => onOpenInsight('趋势')}>查看同期趋势 <ChevronRight size={15} /></button>
      </section>

      <div className="prototype-kpi-grid" aria-label="Token 构成摘要">
        <KpiCard label="输入 Tokens" value={fixture.input} tone="blue" note="占有效 82%" />
        <KpiCard label="输出 Tokens" value={fixture.output} tone="green" note="占有效 18%" />
        <KpiCard label="缓存 Tokens" value={fixture.cache} tone="amber" note={`${fixture.cacheHit} 读取占比`} />
        <KpiCard label="活跃模型" value="13" tone="violet" note="4 个工具在用" />
      </div>

      <SectionHeader title="构成" action="完整来源" onAction={() => onOpenInsight('来源')} />
      <section className="prototype-card prototype-composition-card">
        <div className="prototype-composition-copy"><strong>输入 / 输出</strong><span>缓存单列，不重复计入有效 Token</span></div>
        <div className="prototype-composition-chart"><EChart option={compositionOption} ariaLabel="输入与输出 Token 构成" /></div>
        <div className="prototype-composition-legend"><span className="input">输入 82%</span><span className="output">输出 18%</span></div>
      </section>

      <SectionHeader title="工具分布" action="下钻分析" onAction={() => onOpenInsight('来源')} />
      <section className="prototype-card prototype-distribution-card">
        <div className="prototype-donut"><EChart option={sourceOption} ariaLabel="工具 Token 分布环形图" /><strong>{fixture.tokens}<span>有效</span></strong></div>
        <div className="prototype-source-compact">
          {SOURCE_DATA.map((item) => <SourceRow key={item.name} {...item} compact onClick={() => onOpenInsight('来源')} />)}
        </div>
      </section>

      <SectionHeader title="消耗日历" action="查看全年" onAction={() => onOpenInsight('日历')} />
      <button className="prototype-card prototype-calendar-card" type="button" onClick={() => onOpenInsight('日历')}>
        <div><strong>连续活跃 18 天</strong><span>周三是本月使用峰值</span></div>
        <div className="prototype-heatmap-preview"><EChart option={heatmapOption} ariaLabel="最近十二周消耗日历热力图" /></div>
      </button>

      <SectionHeader title="订阅额度" action="查看全部" onAction={onOpenQuota} />
      <button className="prototype-card prototype-quota-summary" type="button" onClick={onOpenQuota}>
        <QuotaSummary name="Claude" remaining={72} tone="violet" />
        <QuotaSummary name="Codex" remaining={57} tone="blue" />
        <ChevronRight className="prototype-card-chevron" size={17} />
      </button>
    </>
  );
}

function InsightsPage({ mode, setMode, range, fixture, trendOption, sourceOption, heatmapOption }: { mode: InsightMode; setMode: (mode: InsightMode) => void; range: PrototypeRange; fixture: RangeFixture; trendOption: EChartsCoreOption; sourceOption: EChartsCoreOption; heatmapOption: EChartsCoreOption }) {
  const comparison = {
    今日: ['今日 vs 昨日 · 同进度', '今日 11:00 达峰，较昨日同期高 18%。'],
    本周: ['本周 vs 上周 · 同进度', '本周周三达峰，较上周同期高 14%。'],
    本月: ['本月 vs 上月 · 同进度', '本月第二周达峰，较上月同期低 3%。'],
    今年: ['今年 vs 去年 · 同进度', '今年 6 月达峰，较去年同期高 22%。'],
    总计: ['累计趋势 · 全部记录', '累计峰值出现在最近 30 天，活跃度持续上升。'],
  }[range];
  return (
    <>
      <div className="prototype-mode-strip" role="group" aria-label="洞察视图">
        {(['趋势', '来源', '日历', '明细'] as const).map((item) => <button key={item} type="button" className={mode === item ? 'is-selected' : ''} aria-pressed={mode === item} onClick={() => setMode(item)}>{item}</button>)}
      </div>
      {mode === '趋势' && (
        <>
          <section className="prototype-card prototype-insight-card">
            <div className="prototype-card-label"><span>同期趋势</span><small>{comparison[0]}</small></div>
            <div className="prototype-insight-value"><strong>{fixture.tokens}</strong><span>{fixture.delta}</span></div>
            <div className="prototype-analysis-chart"><EChart option={trendOption} ariaLabel="同期 Token 趋势" /></div>
            <div className="prototype-legend"><span className="current">当前周期</span><span className="previous">上一周期</span></div>
          </section>
          <section className="prototype-card prototype-conclusion"><Sparkles size={18} /><div><strong>{range === '总计' ? '累计峰值' : '峰值位置'}</strong><span>{comparison[1]}</span></div></section>
          {/* 三个单值指标走同一个 2 列网格。Android 端目前是三张整宽卡片，每张
              约 100dp 高只为放一个数字，合计吃掉约 300dp 竖向空间——而概览页的
              同类信息本来就是 2×2 网格。同一个 App 不该有两套密度模型。 */}
          <div className="prototype-kpi-grid">
            <KpiCard label="Token 变化" value="+141K" tone="violet" note="+12.4%" />
            <KpiCard label="请求变化" value="+286" tone="blue" note="+10.1%" />
            <KpiCard label="费用变化" value="+¥14.6" tone="amber" note="+12.4%" />
          </div>
        </>
      )}
      {mode === '来源' && (
        <InsightsSourcesSection
          fixture={fixture}
          sourceOption={sourceOption}
        />
      )}
      {mode === '日历' && (
        <>
          <section className="prototype-card prototype-calendar-full">
            <div className="prototype-card-label"><span>活跃日历</span><small>最近 12 周</small></div>
            <div className="prototype-calendar-stats"><div><strong>64</strong><span>活跃天</span></div><div><strong>18</strong><span>连续天</span></div><div><strong>2.6M</strong><span>峰值日</span></div></div>
            <div className="prototype-heatmap-full"><EChart option={heatmapOption} ariaLabel="最近十二周每日消耗热力图" /></div>
            <div className="prototype-heatmap-scale"><span>少</span><i /><i /><i /><i /><span>多</span></div>
          </section>
          <section className="prototype-card prototype-conclusion"><CalendarDays size={18} /><div><strong>周三最活跃</strong><span>平均比其他工作日高 21%，周末使用明显回落。</span></div></section>
        </>
      )}
      {mode === '明细' && (
        <section className="prototype-card prototype-detail-list" aria-label="明细记录">
          {[
            ['12:42', 'Codex CLI · GPT-5.4', '184K', 'MacBook Pro'],
            ['12:18', 'Claude Code · Sonnet 4.5', '162K', 'MacBook Pro'],
            ['11:56', 'Cursor · Auto', '147K', 'Studio'],
            ['11:31', 'Codex CLI · GPT-5.3', '126K', 'Studio'],
          ].map(([time, source, tokens, device]) => <div className="prototype-detail-row" key={`${time}-${source}`}><time>{time}</time><div><strong title={source}>{source}</strong><small title={device}>{device}</small></div><em>{tokens}</em></div>)}
        </section>
      )}
    </>
  );
}

function QuotaPage() {
  return (
    <>
      <div className="prototype-page-intro"><span>订阅窗口</span><p>桌面端读取并同步脱敏快照；来源、风险等级与观测时间保持可见。</p></div>
      {QUOTA_PROVIDERS.map((provider) => (
        <section className="prototype-card prototype-provider-card" key={provider.name}>
          <div className="prototype-provider-head">
            <div className={`prototype-provider-icon ${provider.tone}`}><CircleGauge size={18} /></div>
            <div><strong title={provider.name}>{provider.name}</strong><span title={provider.caption}>{provider.caption}</span></div><em>最新</em>
          </div>
          <div className="prototype-source-pill" title={provider.source}>{provider.source}</div>
          {provider.windows.map((window) => <QuotaWindow key={window.label} {...window} tone={provider.tone} />)}
        </section>
      ))}
      <section className="prototype-card prototype-quota-note"><CircleGauge size={18} /><div><strong>额度不是消费统计</strong><span>两条事实链分开呈现，不用 Token 活动推导订阅余量。</span></div></section>
    </>
  );
}

function WidgetPage({ mode, setMode, fixture, trendOption, heatmapOption, onOpenFullscreen }: { mode: WidgetMode; setMode: (mode: WidgetMode) => void; fixture: RangeFixture; trendOption: EChartsCoreOption; heatmapOption: EChartsCoreOption; onOpenFullscreen: () => void }) {
  const eink = mode === 'eink';
  return (
    <>
      <div className="prototype-widget-switch" role="group" aria-label="摆件显示模式">
        <button type="button" className={!eink ? 'is-selected' : ''} aria-pressed={!eink} onClick={() => setMode('polished')}><SunMedium size={15} />精美摆件</button>
        <button type="button" className={eink ? 'is-selected' : ''} aria-pressed={eink} onClick={() => setMode('eink')}><MoonStar size={15} />墨水屏</button>
      </div>
      <section className={`prototype-widget-frame ${eink ? 'is-eink-layout' : ''}`} aria-label={eink ? '墨水屏摆件预览' : '精美摆件预览'}>
        <div className="prototype-widget-brand"><span>TOKENLEDGER</span><em>{eink ? 'E-INK · 15 MIN' : 'LIVE · 09:41'}</em></div>
        <div className="prototype-widget-primary"><span>今日有效 Token</span><strong>{fixture.tokens}</strong><em>{fixture.delta}</em></div>
        <div className="prototype-widget-chart"><EChart option={trendOption} ariaLabel="摆件今日趋势" /></div>
        <div className="prototype-widget-stats"><Metric label="费用" value={fixture.cost} /><Metric label="请求" value={fixture.requests} /><Metric label="缓存" value={fixture.cacheHit} /></div>
        <div className="prototype-widget-quota"><div><span>Claude 5h</span><strong>72%</strong></div><div><span>Codex 5h</span><strong>57%</strong></div></div>
        <div className="prototype-widget-heatmap"><EChart option={heatmapOption} ariaLabel="摆件活跃日历" /></div>
      </section>
      <section className="prototype-card prototype-widget-explainer">
        {eink ? <MoonStar size={18} /> : <Sparkles size={18} />}
        <div><strong>{eink ? '静态单色 · 15 分钟刷新' : '精细层次 · 数据变化时更新'}</strong><span>{eink ? '禁用动画、阴影和持续重绘，适合长驻墨水屏。' : '保留趋势、额度与活跃日历，适合手机支架或桌面副屏。'}</span></div>
      </section>
      <button className="prototype-widget-enter" type="button" onClick={onOpenFullscreen}>
        <MonitorSmartphone size={18} />
        <span>进入全屏摆件</span>
        <em>进入后保持屏幕常亮</em>
      </button>
    </>
  );
}

function AmbientWidgetScreen({
  fixture,
  mode,
  tokenMode,
  wakeLockActive,
  trendOption,
  heatmapOption,
  claudeOrbit,
  codexOrbit,
  onToggleTokenMode,
}: {
  fixture: RangeFixture;
  mode: WidgetMode;
  tokenMode: PrototypeTokenMode;
  wakeLockActive: boolean;
  trendOption: EChartsCoreOption;
  heatmapOption: EChartsCoreOption;
  claudeOrbit: EChartsCoreOption;
  codexOrbit: EChartsCoreOption;
  onToggleTokenMode: () => void;
}) {
  const displayedTokens = tokenMode === 'effective' ? fixture.tokens : '1.50M';
  return (
    <main
      className={`prototype-ambient-widget ${mode === 'eink' ? 'is-eink-layout' : ''}`}
      aria-label="TokenLedger 全屏常亮摆件"
      data-wake-lock={wakeLockActive ? 'active' : 'unavailable'}
    >
      <span className="prototype-sr-only" role="status" aria-live="polite">
        {wakeLockActive ? '屏幕常亮已启用，按系统返回键退出摆件' : '正在请求屏幕常亮，按系统返回键退出摆件'}
      </span>
      <button
        className="prototype-ambient-primary"
        type="button"
        onClick={onToggleTokenMode}
        role="switch"
        aria-checked={tokenMode === 'all'}
        aria-label={`当前显示${tokenMode === 'effective' ? '有效' : '全部'} Token，点击切换`}
      >
        <span className="prototype-ambient-brand">TOKENLEDGER</span>
        <span className="prototype-ambient-token-label">今日{tokenMode === 'effective' ? '有效' : '全部'} Token</span>
        <strong>{displayedTokens}</strong>
        <em><b>+12.4%</b> 同期</em>
      </button>

      <section className="prototype-ambient-quote" aria-label="今日一句">
        <time dateTime="2026-07-17">7月17日 星期五</time>
        <blockquote>山重水复疑无路，<br />柳暗花明又一村。</blockquote>
        <cite>— 陆游</cite>
      </section>

      <section className="prototype-ambient-quotas" aria-label="订阅额度重置">
        <AmbientQuota provider="Claude" remaining={72} reset="18:10" option={claudeOrbit} />
        <AmbientQuota provider="Codex" remaining={57} reset="20:30" option={codexOrbit} />
      </section>

      <section className="prototype-ambient-trend" aria-label="今日 Token 同期趋势">
        <EChart option={trendOption} ariaLabel="今日有效 Token 与上周同期平滑趋势" />
      </section>

      <footer className="prototype-ambient-footer">
        <div className="prototype-ambient-metrics" aria-label="今日摘要">
          <Metric label="费用" value={fixture.cost} />
          <Metric label="请求" value={fixture.requests} />
          <Metric label="缓存读取占比" value="19%" />
        </div>
        <section className="prototype-ambient-heatmap" aria-label="最近十二周消耗日历">
          <span>最近 12 周 · 连续活跃 18 天</span>
          <EChart option={heatmapOption} ariaLabel="最近十二周每日消耗热力图，连续活跃十八天" />
        </section>
        <span className="prototype-ambient-wordmark" aria-label="Jeidorf">JEIDORF</span>
      </footer>
    </main>
  );
}

function AmbientQuota({ provider, remaining, reset, option }: { provider: string; remaining: number; reset: string; option: EChartsCoreOption }) {
  return (
    <div className="prototype-ambient-quota">
      <span title={`${provider} · 5 小时`}>{provider} · 5 小时</span>
      <div className="prototype-ambient-quota-chart">
        <EChart option={option} ariaLabel={`${provider} 5 小时额度剩余 ${remaining}%`} />
        <div className="prototype-ambient-quota-value" aria-hidden="true">
          <strong>{remaining}<small>%</small></strong>
          <em>可用</em>
        </div>
      </div>
      <time title={`重置 ${reset}`}>重置 {reset}</time>
    </div>
  );
}

function SettingsPage({ forceLandscape, onForceLandscapeChange }: { forceLandscape: boolean; onForceLandscapeChange: (enabled: boolean) => void }) {
  return (
    <>
      <div className="prototype-page-intro"><span>移动看板偏好</span><p>只保留影响阅读、摆件和能耗的设置。</p></div>
      <section className="prototype-card prototype-settings-list">
        <SettingsRow icon={Sparkles} title="显示主题" value="跟随系统" />
        <SettingsSwitchRow
          icon={RotateCw}
          title="强制横屏"
          description="关闭时跟随系统方向"
          checked={forceLandscape}
          onChange={onForceLandscapeChange}
        />
        <SettingsRow icon={LayoutDashboard} title="首页模块" value="完整看板" />
        <SettingsRow icon={MonitorSmartphone} title="默认摆件" value="精美模式" />
        <SettingsRow icon={RefreshCw} title="摆件刷新" value="数据变化时" />
        <SettingsRow icon={ListTree} title="明细密度" value="舒适" />
      </section>
      <section className={`prototype-card prototype-orientation-note ${forceLandscape ? 'is-active' : ''}`} aria-live="polite">
        <RotateCw size={18} />
        <div>
          <strong>{forceLandscape ? '看板已锁定横屏' : '当前跟随系统旋转'}</strong>
          <span>{forceLandscape ? '概览、洞察、额度与摆件都会保持横向；可随时回到此处关闭。' : '打开后进入应用即保持横屏，适合支架、桌面副屏和摆件模式。'}</span>
        </div>
      </section>
    </>
  );
}

function RangeSelector({ range, setRange }: { range: PrototypeRange; setRange: (range: PrototypeRange) => void }) {
  return <div className="prototype-segmented" role="group" aria-label="统计时间范围">{(Object.keys(RANGE_FIXTURES) as PrototypeRange[]).map((item) => <button key={item} type="button" className={range === item ? 'is-selected' : ''} aria-pressed={range === item} onClick={() => setRange(item)}>{item}</button>)}</div>;
}

function FilterSheet({ machine, onSelect, onClose }: { machine: string; onSelect: (value: string) => void; onClose: () => void }) {
  const sheetRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const sheet = sheetRef.current;
    if (!sheet) return undefined;

    const getFocusableElements = () => Array.from(
      sheet.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'),
    ).filter((element) => {
      const style = window.getComputedStyle(element);
      return !element.hasAttribute('hidden') && style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
    });

    closeButtonRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusableElements = getFocusableElements();
      if (focusableElements.length === 0) {
        event.preventDefault();
        sheet.focus();
        return;
      }
      const first = focusableElements[0];
      const last = focusableElements[focusableElements.length - 1];
      if (event.shiftKey && (document.activeElement === first || !sheet.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !sheet.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      restoreFocusRef.current?.focus();
      restoreFocusRef.current = null;
    };
  }, []);

  return (
    <div className="prototype-sheet-backdrop" role="presentation" onClick={onClose}>
      <section ref={sheetRef} className="prototype-sheet" role="dialog" aria-modal="true" aria-labelledby="filter-sheet-title" tabIndex={-1} onClick={(event) => event.stopPropagation()}>
        <div className="prototype-sheet-handle" />
        <div className="prototype-sheet-head"><div><span>筛选</span><h3 id="filter-sheet-title">限定看板范围</h3></div><button ref={closeButtonRef} type="button" onClick={onClose} aria-label="关闭筛选"><X size={18} /></button></div>
        <div className="prototype-filter-section"><strong>设备</strong><div className="prototype-choice-grid">{['全部设备', 'MacBook Pro', 'Studio'].map((item) => <button key={item} type="button" className={machine === item ? 'is-selected' : ''} onClick={() => onSelect(item)}>{item}</button>)}</div></div>
        <div className="prototype-filter-section"><strong>工具与模型</strong><div className="prototype-sheet-row is-static"><span>全部工具 · 全部模型</span><small>未限定</small></div></div>
        <button className="prototype-sheet-done" type="button" onClick={onClose}>应用筛选</button>
      </section>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) { return <div className="prototype-metric"><span>{label}</span><strong>{value}</strong></div>; }
function SectionHeader({ title, action, onAction }: { title: string; action: string; onAction: () => void }) { return <div className="prototype-section-head"><h3>{title}</h3><button type="button" onClick={onAction}>{action}<ChevronRight size={13} /></button></div>; }
function KpiCard({ label, value, note, tone }: { label: string; value: string; note: string; tone: 'blue' | 'green' | 'amber' | 'violet' }) { return <section className="prototype-card prototype-kpi-card"><span className={`prototype-kpi-mark ${tone}`} /> <div><span>{label}</span><strong>{value}</strong><em>{note}</em></div></section>; }

function QuotaSummary({ name, remaining, tone }: { name: string; remaining: number; tone: 'violet' | 'blue' }) {
  return <div className="prototype-quota-summary-row"><span className={`prototype-quota-dot ${tone}`} /><div><strong title={name}>{name}</strong><span>5 小时窗口</span></div><em>{remaining}% <small>剩余</small></em></div>;
}

/**
 * 剩余额度的严重度分级。
 *
 * 此前进度条用的是厂商色（violet/blue），也就是说 57% 剩余和 8% 剩余长得一模
 * 一样——「快用完了」这件事在界面上没有任何视觉权重。颜色改为只表达剩余量后，
 * 厂商身份由左侧圆点承担，一个通道一种语义。
 *
 * 阈值与桌面 `quotaOverview.ts`、Android 应用和小组件统一为剩余 <20% 告急、<50% 偏紧（D4，T10.152/T10.161）。
 */
export function quotaSeverity(remaining: number): 'healthy' | 'warning' | 'critical' {
  if (remaining < 20) return 'critical';
  if (remaining < 50) return 'warning';
  return 'healthy';
}

function QuotaWindow({ label, used, reset, tone }: { label: string; used: number; reset: string; tone: 'violet' | 'blue' }) {
  const remaining = 100 - used;
  const severity = quotaSeverity(remaining);
  return (
    <div className="prototype-window-row">
      <div><strong title={label}>{label}</strong><em className={`prototype-quota-remaining ${severity}`}>{remaining}% 剩余</em></div>
      <div className="prototype-progress"><span className={severity} style={{ width: `${remaining}%` }} /></div>
      <small title={reset}>{reset}</small>
      <span className="sr-only">{`剩余 ${remaining}%，${severity === 'critical' ? '额度告急' : severity === 'warning' ? '额度偏紧' : '额度充足'}`}</span>
      {/* tone 仍然表示厂商，交给上层的圆点使用，这里刻意不再参与条形颜色。 */}
      <span hidden data-provider-tone={tone} />
    </div>
  );
}

function SourceRow({ name, value, percent, color, models, compact = false, isExpanded, onClick }: { name: string; value: string; percent: number; color: string; models: string; compact?: boolean; isExpanded?: boolean; onClick?: () => void }) {
  const rowClass = `prototype-source-row ${compact ? 'is-compact' : ''}${onClick ? '' : ' is-static'}`;
  const rowContent = (
    <>
      <span className="prototype-source-symbol" style={{ background: color }} />
      <div><strong title={name}>{name}</strong><span title={compact ? `${percent}% 有效 Token` : models}>{compact ? `${percent}% 有效 Token` : models}</span></div>
      <em>{value}</em>
    </>
  );

  if (!onClick) return <div className={rowClass}>{rowContent}</div>;

  return (
    <button className={rowClass} type="button" onClick={onClick} aria-label={compact ? `打开${name}来源分析` : `展开${name}缓存命中分布`}>
      {rowContent}
      <ChevronRight size={15} style={{ transform: isExpanded ? 'rotate(90deg)' : 'none', transition: 'transform 0.2s cubic-bezier(0.4, 0, 0.2, 1)' }} />
    </button>
  );
}

function InsightsSourcesSection({ fixture, sourceOption }: { fixture: RangeFixture; sourceOption: EChartsCoreOption }) {
  const [expandedModel, setExpandedModel] = useState<string | null>(null);

  const modelRows = [
    {
      name: 'claude-3-5-sonnet',
      value: '¥18.60',
      percent: 62,
      color: '#8b5cf6',
      models: '62% · 复用率 82.5% · 省 ¥14.20',
      segments: [
        { label: '输入', tokens: '420K' },
        { label: '输出', tokens: '95K' },
        { label: '缓存读取', tokens: '680K' },
      ],
      reusePercent: 82.5,
      savedCost: '¥14.20',
    },
    {
      name: 'gpt-4o',
      value: '¥8.20',
      percent: 27,
      color: '#3b82f6',
      models: '27% · 复用率 45.0% · 省 ¥4.80',
      segments: [
        { label: '输入', tokens: '210K' },
        { label: '输出', tokens: '55K' },
        { label: '缓存读取', tokens: '140K' },
      ],
      reusePercent: 45.0,
      savedCost: '¥4.80',
    },
    {
      name: 'deepseek-v3',
      value: '¥3.10',
      percent: 11,
      color: '#10b981',
      models: '11% · 复用率 90.0% · 省 ¥8.50',
      segments: [
        { label: '输入', tokens: '120K' },
        { label: '输出', tokens: '35K' },
        { label: '缓存读取', tokens: '410K' },
      ],
      reusePercent: 90.0,
      savedCost: '¥8.50',
    },
  ];

  return (
    <>
      <section className="prototype-card prototype-source-analysis">
        <div className="prototype-large-donut">
          <EChart option={sourceOption} ariaLabel="工具来源占比" />
          <strong>{fixture.tokens}<span>总有效</span></strong>
        </div>
        <div className="prototype-source-list">
          {SOURCE_DATA.map((item) => <SourceRow key={item.name} {...item} />)}
        </div>
      </section>
      <section className="prototype-card prototype-source-analysis">
        <div className="prototype-card-label">
          <span>模型费用与缓存命中分布</span>
          <small>按预估费用降序，点击展开命中缓存分布</small>
        </div>
        <div className="prototype-source-list">
          {modelRows.map((item) => {
            const isOpen = expandedModel === item.name;
            return (
              <div key={item.name} className="prototype-model-cost-item">
                <SourceRow
                  name={item.name}
                  value={item.value}
                  percent={item.percent}
                  color={item.color}
                  models={item.models}
                  isExpanded={isOpen}
                  onClick={() => setExpandedModel(isOpen ? null : item.name)}
                />
                {isOpen && (
                  <div className="prototype-model-breakdown-card" style={{
                    margin: '4px 0 8px',
                    padding: '10px 12px',
                    borderRadius: '8px',
                    background: 'rgba(255, 255, 255, 0.04)',
                    border: '1px solid rgba(255, 255, 255, 0.08)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '6px',
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '11px' }}>
                      <span style={{ color: 'rgba(255, 255, 255, 0.5)' }}>Prompt 缓存命中明细</span>
                      <span style={{
                        padding: '2px 8px',
                        borderRadius: '10px',
                        background: 'rgba(16, 185, 129, 0.15)',
                        color: '#34d399',
                        fontWeight: 600,
                        fontSize: '10px',
                      }}>
                        复用率 {item.reusePercent}% · 省 {item.savedCost}
                      </span>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                      {item.segments.map((seg) => (
                        <div key={seg.label} style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          padding: '4px 8px',
                          borderRadius: '4px',
                          background: 'rgba(255, 255, 255, 0.03)',
                          fontSize: '11px',
                        }}>
                          <span style={{ color: 'rgba(255, 255, 255, 0.7)' }}>{seg.label}</span>
                          <strong style={{ fontWeight: 600 }}>{seg.tokens}</strong>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>
    </>
  );
}

function SettingsRow({ icon: Icon, title, value }: { icon: typeof Gauge; title: string; value: string }) { return <div className="prototype-settings-row"><span><Icon size={17} /></span><strong>{title}</strong><em>{value}</em></div>; }

function SettingsSwitchRow({ icon: Icon, title, description, checked, onChange }: { icon: typeof Gauge; title: string; description: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <button
      className="prototype-settings-switch-row"
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={`${title}，${checked ? '已开启' : '已关闭'}`}
      onClick={() => onChange(!checked)}
    >
      <span><Icon size={17} /></span>
      <span className="prototype-settings-copy"><strong>{title}</strong><small>{description}</small></span>
      <span className={`prototype-switch ${checked ? 'is-on' : ''}`} aria-hidden="true"><i /></span>
    </button>
  );
}

export default AndroidDashboardPrototype;
