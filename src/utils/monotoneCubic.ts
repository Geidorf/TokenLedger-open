/**
 * 单调三次曲线（Fritsch–Carlson，T10.190 P4、T10.192）。
 *
 * 走势线穿过每个数据点，并且每一段都夹在这一段两端的数据之间：峰值不会被画得比数据高，
 * 零值不会被画成负数，平的一段仍然是平的。挂件的旧走势用直线段硬连并按窗口拉伸，峰值失真；
 * 普通的三次样条（Catmull-Rom 之类）又会在峰前峰后冲出数据范围。锁屏、Android 与
 * T10.190 视觉稿用的是同一种曲线。
 *
 * 约定：x 严格递增；x、y 都是有限数。调用方先剔除读不到的点，不要用 0 顶替（GLB-01）。
 */

export interface CurvePoint {
  x: number;
  y: number;
}

/** 一段三次贝塞尔：起点、两个控制点、终点。 */
export interface CubicSegment {
  from: CurvePoint;
  c1: CurvePoint;
  c2: CurvePoint;
  to: CurvePoint;
}

/**
 * 各点的切线斜率。内部点在两侧割线同号时取平均、异号或有一侧为平时取 0（极值点处切线水平）；
 * 端点取单侧割线；再按 α² + β² ≤ 9 收缩，保证每一段单调，不越过两端数据。
 */
export function monotoneTangents(points: readonly CurvePoint[]): number[] {
  const count = points.length;
  if (count < 2) return points.map(() => 0);
  const secants: number[] = [];
  for (let index = 0; index < count - 1; index += 1) {
    secants.push((points[index + 1].y - points[index].y) / (points[index + 1].x - points[index].x));
  }
  const tangents = [secants[0]];
  for (let index = 1; index < count - 1; index += 1) {
    const left = secants[index - 1];
    const right = secants[index];
    tangents.push(left * right <= 0 ? 0 : (left + right) / 2);
  }
  tangents.push(secants[count - 2]);
  for (let index = 0; index < count - 1; index += 1) {
    const secant = secants[index];
    if (secant === 0) {
      tangents[index] = 0;
      tangents[index + 1] = 0;
      continue;
    }
    const alpha = tangents[index] / secant;
    const beta = tangents[index + 1] / secant;
    const sum = alpha * alpha + beta * beta;
    if (sum > 9) {
      const scale = 3 / Math.sqrt(sum);
      tangents[index] = scale * alpha * secant;
      tangents[index + 1] = scale * beta * secant;
    }
  }
  return tangents;
}

/** 按 Hermite → 贝塞尔换算出每一段的控制点：控制点在 1/3 处，纵向沿切线。 */
export function monotoneCubicSegments(points: readonly CurvePoint[]): CubicSegment[] {
  const tangents = monotoneTangents(points);
  const segments: CubicSegment[] = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const from = points[index];
    const to = points[index + 1];
    const third = (to.x - from.x) / 3;
    segments.push({
      from,
      c1: { x: from.x + third, y: from.y + tangents[index] * third },
      c2: { x: to.x - third, y: to.y - tangents[index + 1] * third },
      to,
    });
  }
  return segments;
}

/** 贝塞尔一段在参数 t（0–1）处的点，测试与读屏摘要用。 */
export function cubicPointAt(segment: CubicSegment, t: number): CurvePoint {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return {
    x: a * segment.from.x + b * segment.c1.x + c * segment.c2.x + d * segment.to.x,
    y: a * segment.from.y + b * segment.c1.y + c * segment.c2.y + d * segment.to.y,
  };
}

function round(value: number, digits: number): number {
  const rounded = Number(value.toFixed(digits));
  return Object.is(rounded, -0) ? 0 : rounded;
}

/**
 * SVG 路径 `M… C…`。坐标按 `digits` 位小数取整后，控制点的纵坐标再夹回这一段两端
 * （取整后）的纵坐标之间：贝塞尔曲线落在控制多边形的凸包里，取整不会带来哪怕 0.05px 的越界。
 * 少于两个点时只给起点（或空串），由调用方决定画点还是写「没有走势」。
 */
export function monotoneCubicPath(points: readonly CurvePoint[], digits = 1): string {
  if (points.length === 0) return '';
  let path = `M${round(points[0].x, digits)} ${round(points[0].y, digits)}`;
  for (const segment of monotoneCubicSegments(points)) {
    const fromY = round(segment.from.y, digits);
    const toY = round(segment.to.y, digits);
    const low = Math.min(fromY, toY);
    const high = Math.max(fromY, toY);
    const clampY = (value: number) => Math.min(high, Math.max(low, round(value, digits)));
    path += ` C${round(segment.c1.x, digits)} ${clampY(segment.c1.y)}`
      + ` ${round(segment.c2.x, digits)} ${clampY(segment.c2.y)}`
      + ` ${round(segment.to.x, digits)} ${toY}`;
  }
  return path;
}
