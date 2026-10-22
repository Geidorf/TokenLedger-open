import type { ToolStat } from '../types';
import { colorsForToolsInView, effectiveTokens, ESTIMATED_TOOLS } from '../types';
import { formatNum, formatTokens } from '../utils/format';
import { toolDisplayName } from '../utils/toolDisplayName';
import { useTheme } from '../utils/useTheme';
import { BrandIcon } from './brand/BrandIcon';

interface ToolStripProps {
  activeTools: ToolStat[];
  showTotalTokens: boolean;
  onToolClick?: (tool: ToolStat) => void;
}

export function ToolStrip({ activeTools, showTotalTokens, onToolClick }: ToolStripProps) {
  const { effective } = useTheme();
  // activeTools is already rank-ordered (useStats sorts by displayed tokens
  // desc), so this resolves same-slot collisions by that same rank (T10.178).
  const toolColors = colorsForToolsInView(activeTools.map((tool) => tool.name), effective);
  return (
    <section className="tool-strip">
      {activeTools.map((tool, index) => {
        const val = showTotalTokens
          ? (tool.input || 0) + (tool.output || 0) + (tool.cached || 0)
          : effectiveTokens(tool);

        const label = toolDisplayName(tool.name);
        return (
          <button
            key={tool.name}
            className="tool-chip tl-press"
            type="button"
            onClick={() => onToolClick?.(tool)}
            aria-label={`打开 ${label} 专属看板`}
          >
            <div className="tool-chip-name truncate">
              <BrandIcon name={tool.name} color={toolColors[index]} size={18} />
              <span className="tool-chip-dot" aria-hidden="true" style={{ background: toolColors[index] }} />
              {label}
              {ESTIMATED_TOOLS.has(tool.name.toLowerCase()) && (
                <span
                  className="ml-1 text-xs text-warning"
                  title={
                    tool.name.toLowerCase() === 'antigravity'
                      ? '含旧版 App 估算值（CLI 新版为真实上报用量）'
                      : 'Token 为估算值'
                  }
                >
                  ≈
                </span>
              )}
            </div>
            <div className="tool-chip-value num">{formatTokens(val)}</div>
            <div style={{ fontSize: '11px', color: 'var(--color-text-caption)', marginTop: 2 }}>
              {formatNum(tool.requests)} 条记录
            </div>
          </button>
        );
      })}
    </section>
  );
}

export default ToolStrip;
