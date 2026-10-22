import { describe, expect, it } from 'vitest';
import {
  cubicPointAt,
  monotoneCubicPath,
  monotoneCubicSegments,
  monotoneTangents,
  type CubicSegment,
  type CurvePoint,
} from './monotoneCubic';

/** 固定种子的伪随机数（mulberry32），让「随机」用例每次都一样。 */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const at = (values: readonly number[], step = 10): CurvePoint[] => values.map((y, index) => ({ x: index * step, y }));

/** 每一段在 t ∈ [0, 1] 上取 65 个点，找出越出这一段两端数据的地方。 */
function overshoots(segments: readonly CubicSegment[], epsilon = 1e-9): string[] {
  const problems: string[] = [];
  segments.forEach((segment, index) => {
    const low = Math.min(segment.from.y, segment.to.y) - epsilon;
    const high = Math.max(segment.from.y, segment.to.y) + epsilon;
    for (let step = 0; step <= 64; step += 1) {
      const point = cubicPointAt(segment, step / 64);
      if (point.y < low || point.y > high) problems.push(`第 ${index} 段 t=${step / 64} y=${point.y}（应在 ${low}…${high}）`);
      if (point.x < segment.from.x - epsilon || point.x > segment.to.x + epsilon) problems.push(`第 ${index} 段 x 回折`);
    }
  });
  return problems;
}

/** 把 `M… C…` 路径还原成贝塞尔段，检查取整后真正画出来的那条线。 */
function segmentsFromPath(path: string): CubicSegment[] {
  const numbers = path.replace(/[MC]/g, ' ').trim().split(/\s+/).map(Number);
  const segments: CubicSegment[] = [];
  let from = { x: numbers[0], y: numbers[1] };
  for (let index = 2; index + 5 < numbers.length; index += 6) {
    const segment = {
      from,
      c1: { x: numbers[index], y: numbers[index + 1] },
      c2: { x: numbers[index + 2], y: numbers[index + 3] },
      to: { x: numbers[index + 4], y: numbers[index + 5] },
    };
    segments.push(segment);
    from = segment.to;
  }
  return segments;
}

// T10.190 视觉稿的示例：今日每小时的有效 Token（千），峰前峰后陡升陡降，最容易冲出数据范围。
const SPIKY = [0, 0, 0, 0, 0, 0, 0, 28, 100, 237, 306, 267, 90, 217, 144];

describe('单调三次曲线（T10.192）', () => {
  it('穿过每一个数据点', () => {
    const points = at(SPIKY);
    const segments = monotoneCubicSegments(points);
    expect(segments).toHaveLength(points.length - 1);
    segments.forEach((segment, index) => {
      expect(segment.from).toEqual(points[index]);
      expect(segment.to).toEqual(points[index + 1]);
    });
  });

  it('峰值不被画高、零值不被画成负数：示例走势每一段都夹在两端数据之间', () => {
    expect(overshoots(monotoneCubicSegments(at(SPIKY)))).toEqual([]);
    // 峰值处切线水平，整条线的最高点就是数据的最高点。
    const peak = Math.max(...monotoneCubicSegments(at(SPIKY)).flatMap((segment) => (
      Array.from({ length: 65 }, (_, step) => cubicPointAt(segment, step / 64).y)
    )));
    expect(peak).toBeCloseTo(306, 9);
  });

  it('陡升之前的平台不会先往下凹（切线按 α² + β² ≤ 9 收缩）', () => {
    // 不收缩时第一段的第二个控制点落到 -1.57，线会先钻到 0 以下再爬上去。
    const points = [{ x: 0, y: 0 }, { x: 1, y: 0.1 }, { x: 2, y: 10 }, { x: 3, y: 10.1 }];
    expect(overshoots(monotoneCubicSegments(points))).toEqual([]);
    const [a, b] = monotoneTangents(points);
    const secant = 0.1;
    expect((a / secant) ** 2 + (b / secant) ** 2).toBeLessThanOrEqual(9 + 1e-9);
  });

  it('固定种子的 200 组随机数据（含不等距的 x）都不越界', () => {
    const random = seeded(20260926);
    for (let run = 0; run < 200; run += 1) {
      const count = 2 + Math.floor(random() * 30);
      let x = 0;
      const points = Array.from({ length: count }, () => {
        x += 0.25 + random() * 12;
        // 三成是 0，模拟夜里没有用量的小时。
        return { x, y: random() < 0.3 ? 0 : Math.round(random() * 500_000) };
      });
      expect(overshoots(monotoneCubicSegments(points)), `第 ${run} 组`).toEqual([]);
    }
  });

  it('取整后真正写进 SVG 的路径同样不越界', () => {
    const random = seeded(7);
    const datasets = [SPIKY.map((value) => 3 + 52 * (1 - value / 306)), ...Array.from({ length: 50 }, () => (
      Array.from({ length: 24 }, () => (random() < 0.25 ? 58 : 3 + random() * 55))
    ))];
    for (const values of datasets) {
      const points = values.map((y, index) => ({ x: ((index + 0.5) / 24) * 328, y }));
      const drawn = segmentsFromPath(monotoneCubicPath(points));
      expect(drawn).toHaveLength(points.length - 1);
      expect(overshoots(drawn)).toEqual([]);
    }
  });

  it('平的一段保持平直，共线的点连成直线', () => {
    // 夜里连续几个小时都是 0：这几段必须是贴着 0 的直线，不能因为后面要爬升而提前拱起。
    const [first, second, rise] = monotoneCubicSegments(at([5, 5, 5, 9]));
    for (const segment of [first, second]) {
      expect(segment.c1.y).toBe(5);
      expect(segment.c2.y).toBe(5);
    }
    expect(rise.c1.y).toBe(5);
    for (const segment of monotoneCubicSegments(at([0, 10, 20, 30]))) {
      // 控制点落在同一条直线 y = x 上。
      expect(segment.c1.y).toBeCloseTo(segment.c1.x, 9);
      expect(segment.c2.y).toBeCloseTo(segment.c2.x, 9);
    }
  });

  it('点太少时不硬画：空数组给空串，一个点只有起点，两个点是一段直线', () => {
    expect(monotoneCubicPath([])).toBe('');
    expect(monotoneCubicPath([{ x: 1.25, y: 3 }])).toBe('M1.3 3');
    const [segment] = monotoneCubicSegments([{ x: 0, y: 0 }, { x: 3, y: 6 }]);
    expect(segment.c1).toEqual({ x: 1, y: 2 });
    expect(segment.c2).toEqual({ x: 2, y: 4 });
    expect(monotoneCubicPath([{ x: 0, y: 0 }, { x: 3, y: 6 }])).toBe('M0 0 C1 2 2 4 3 6');
  });
});
