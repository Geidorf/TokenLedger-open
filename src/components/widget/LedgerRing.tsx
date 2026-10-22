import type { QuotaLevel } from '../../utils/quotaOverview';

/**
 * 额度圆环（T10.192，方案 §5.2、§6.3；与 Android Ledger Rings 同规则，DESIGN §6.4）：
 * 环 = 可用百分比，按档位只用 primary / warning / danger 三色，环心只放数字（数字不染色），
 * 来源、窗口与档位字写在环外。圆环本身对读屏是装饰，文字替代由调用方给整格。
 */

/** 三种尺寸：迷你 44（用量详情）、92（额度与用量）、64（额度总览）。线宽与环心字号照视觉稿。 */
export type RingSize = 44 | 64 | 92;

const NUMBER_SIZE: Record<RingSize, number> = { 44: 12, 64: 17, 92: 24 };

export interface RingGeometry {
  size: number;
  stroke: number;
  radius: number;
  circumference: number;
  /** 弧长；可用 0% 时为 0（不画弧，圆头线帽会把 0 长画成一个点）。 */
  arc: number;
}

/** 线宽取尺寸的 10%（至少 3px），弧长 = 可用比例 × 周长；比例先夹回 0–100。 */
export function ringGeometry(size: number, available: number): RingGeometry {
  const stroke = Math.max(3, Math.round(size * 0.1));
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const share = Number.isFinite(available) ? Math.min(100, Math.max(0, available)) / 100 : 0;
  return { size, stroke, radius, circumference, arc: share * circumference };
}

export function LedgerRing({ size, available, level, stale = false, unavailable = false, sub }: {
  size: RingSize;
  /** null = 没有读数：只画轨道，环心写「—」。 */
  available: number | null;
  level: QuotaLevel | null;
  /** 历史快照：弧改用轴线灰（“淡化”，DESIGN §6.4），环外另写「待刷新」。 */
  stale?: boolean;
  /**
   * 整次读取失败：轨道画成虚线空槽，不按档位上色（P2-1，T10.192 修复轮；DESIGN §6.4、
   * T10.190 方案 §5）。「不可用」文字由调用方写在环外，与其余状态词同一位置。
   */
  unavailable?: boolean;
  /** 数字下的小字（「可用」）；迷你环与总览环不写。 */
  sub?: string;
}) {
  const geometry = ringGeometry(size, available ?? 0);
  const center = size / 2;
  const numberSize = NUMBER_SIZE[size];
  return (
    <span
      className="wl-ring"
      data-size={size}
      data-level={level ?? 'none'}
      data-stale={stale ? 'true' : undefined}
      data-unavailable={unavailable ? 'true' : undefined}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} focusable="false">
        <circle className="wl-ring-track" cx={center} cy={center} r={geometry.radius} strokeWidth={geometry.stroke} />
        {available !== null && geometry.arc > 0 && (
          <circle
            className="wl-ring-arc"
            cx={center}
            cy={center}
            r={geometry.radius}
            strokeWidth={geometry.stroke}
            strokeDasharray={`${geometry.arc.toFixed(2)} ${geometry.circumference.toFixed(2)}`}
            transform={`rotate(-90 ${center} ${center})`}
          />
        )}
      </svg>
      <span className="wl-ring-center" style={{ fontSize: numberSize }}>
        <span className="wl-ring-num">
          {available === null ? '—' : available}
          {available !== null && <small>%</small>}
        </span>
        {sub && <span className="wl-ring-sub">{sub}</span>}
      </span>
    </span>
  );
}
