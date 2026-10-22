import { useCallback, useEffect, useRef } from 'react';
import type { EChartsCoreOption, EChartsType } from 'echarts/core';

interface EChartProps {
  option: unknown;
  className?: string;
  onEvents?: Record<string, (params: any) => void>;
  ariaLabel?: string;
  runtime?: 'dashboard' | 'prototype';
}

// Thin ECharts wrapper. Sets the option on mount/update and resizes
// on window resize. The caller (App.tsx) memoizes the `option` so we
// only re-set when the data changes.
export function EChart({ option, className = 'h-full w-full', onEvents, ariaLabel = '数据图表', runtime = 'dashboard' }: EChartProps) {
  const ref = useRef<HTMLDivElement>(null);
  const chart = useRef<EChartsType | null>(null);
  const boundEvents = useRef<Record<string, (params: any) => void> | null>(null);
  const onEventsRef = useRef(onEvents);
  const resizeFrame = useRef<number | null>(null);

  const scheduleResize = useCallback(() => {
    if (resizeFrame.current !== null) return;
    resizeFrame.current = requestAnimationFrame(() => {
      resizeFrame.current = null;
      chart.current?.resize();
    });
  }, []);

  // 两个函数只碰 ref，不读任何渲染期值，因此可以安全地做成恒定引用。
  // 之前它们每次渲染都重建，下面的 effect 只能把它们从依赖里省掉——
  // react-hooks/exhaustive-deps 上线后这正是它报的那两条。用 useCallback
  // 稳定身份是真修，而不是压掉告警。
  const clearEvents = useCallback(() => {
    if (!chart.current || !boundEvents.current) return;
    Object.keys(boundEvents.current).forEach((name) => {
      chart.current?.off(name);
    });
    boundEvents.current = null;
  }, []);

  const applyEvents = useCallback((events?: Record<string, (params: any) => void>) => {
    clearEvents();
    if (!chart.current || !events) return;
    Object.entries(events).forEach(([name, handler]) => {
      chart.current?.on(name, handler);
    });
    boundEvents.current = events;
  }, [clearEvents]);

  useEffect(() => {
    if (!ref.current) return;
    let cancelled = false;

    const runtimeModule = runtime === 'prototype'
      ? import('../echartsPrototypeRuntime')
      : import('../echartsRuntime');
    runtimeModule.then(({ init }) => {
      if (cancelled || !ref.current) return;
      if (!chart.current) {
        chart.current = init(ref.current);
      }
      // Refresh options safely across data, track modes (single/dual axis), and theme updates.
      chart.current.setOption(option as EChartsCoreOption, {
        notMerge: true,
        lazyUpdate: true,
      });
      scheduleResize();
      if (onEventsRef.current && !boundEvents.current) {
        applyEvents(onEventsRef.current);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [option, runtime, scheduleResize, applyEvents]);

  useEffect(() => {
    onEventsRef.current = onEvents;
    applyEvents(onEvents);
  }, [onEvents, applyEvents]);

  useEffect(() => {
    const observer = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(scheduleResize);
    if (observer && ref.current) {
      observer.observe(ref.current);
    } else {
      window.addEventListener('resize', scheduleResize);
    }
    return () => {
      window.removeEventListener('resize', scheduleResize);
      observer?.disconnect();
      if (resizeFrame.current !== null) {
        cancelAnimationFrame(resizeFrame.current);
        resizeFrame.current = null;
      }
      clearEvents();
      chart.current?.dispose();
      chart.current = null;
    };
  }, [scheduleResize, clearEvents]);

  return <div ref={ref} className={className} role="img" aria-label={ariaLabel} tabIndex={-1} />;
}

export default EChart;
