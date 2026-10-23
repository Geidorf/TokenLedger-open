import type { ReactNode } from 'react';
import { RoutingStage, RoutingStageEmpty } from '../../features/gateway/RoutingStage';
import type { RoutingScene } from '../../features/gateway/routingScene';

/**
 * 「实时路由」板式 364×300：标题行（在途 / 已改道 / 失败）+ 紧凑舞台。
 * 舞台与主窗口路由页是同一个组件和同一套场景，只画真实记录；读不到网关时给空态，不播放示意动画。
 * 设置页预览不读网关（`scene` 为 null），只写这块挂件会显示什么。
 */
export function RoutingCard({ scene, loaded, toolbar }: { scene: RoutingScene | null; loaded: boolean; toolbar?: ReactNode }) {
  const stats = scene?.stats;
  const summary = !scene
    ? '示例不含实时数据'
    : !loaded
      ? '正在读取…'
      : scene.empty || !stats
        ? ''
        : `在途 ${stats.inflight} · 已改道 ${stats.rerouted} · 失败 ${stats.failed}`;
  return (
    <div className="wl-card" data-layout="routing">
      <div className="wl-row wl-title">
        <span className="wl-cap">实时路由</span>
        <span className="wl-meta wl-under-toolbar">{summary}</span>
      </div>
      {toolbar}
      <div className="wl-routing">
        {!scene ? (
          <div className="rs-empty is-compact" role="note">
            <b>Agent → 网关 → 上游</b>
            <span>网关有请求时在这里实时流动，失败切换到下一个成员时可见。</span>
          </div>
        ) : !loaded ? null : scene.empty ? (
          <RoutingStageEmpty scene={scene} variant="compact" />
        ) : (
          <RoutingStage scene={scene} variant="compact" />
        )}
      </div>
    </div>
  );
}
