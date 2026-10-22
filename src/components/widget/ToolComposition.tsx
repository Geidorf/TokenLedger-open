import type { CardTools } from './cardModel';

/**
 * 8px 工具构成条 + 图例（T10.192，方案 §6.3、§6.4）。颜色只表达工具身份（配色 B，共用槽位表），
 * 旁边一定写工具显示名与份额；条本身对读屏是装饰，图例是一张列表。
 */
export function ToolComposition({ tools, loading }: { tools: CardTools | null; loading: boolean }) {
  if (!tools) {
    return (
      <div className="wl-tools is-empty">
        <div className="wl-tools-bar" aria-hidden="true" />
        <p className="wl-legend-empty">{loading ? '' : '这个范围还没有工具用量'}</p>
      </div>
    );
  }
  const parts = [
    ...tools.items.map((item) => ({ key: item.id, share: item.share, color: item.color })),
    ...(tools.other ? [{ key: '其他', share: tools.other.share, color: 'var(--wl-other)' }] : []),
  ];
  return (
    <div className="wl-tools">
      <div className="wl-tools-bar" aria-hidden="true">
        {/* 份额放大 1000 倍当 flex-grow：合计不足 1 时 flex 不会铺满整条。 */}
        {parts.map((part) => (
          <i key={part.key} style={{ flexGrow: part.share * 1000, background: part.color }} />
        ))}
      </div>
      <ul className="wl-legend" aria-label="工具构成（有效 Token 份额）">
        {tools.items.map((item) => (
          <li key={item.id}>
            <i style={{ background: item.color }} aria-hidden="true" />
            <span className="wl-legend-name">{item.name}</span>
            <span className="wl-legend-share">{` ${item.percent}`}</span>
          </li>
        ))}
        {tools.other && (
          <li>
            <i style={{ background: 'var(--wl-other)' }} aria-hidden="true" />
            <span className="wl-legend-name">其他</span>
            <span className="wl-legend-share">{` ${tools.other.percent}`}</span>
          </li>
        )}
      </ul>
    </div>
  );
}
