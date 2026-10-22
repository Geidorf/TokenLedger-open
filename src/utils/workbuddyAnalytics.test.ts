import { describe, expect, it } from 'vitest';
import {
  calculateActiveDaysDailyAvg,
  calculateIoRatio,
} from './workbuddyAnalytics';
import type { ModelStat } from '../types';

describe('workbuddyAnalytics utils', () => {
  describe('calculateIoRatio', () => {
    it('handles zero tokens', () => {
      expect(calculateIoRatio(0, 0)).toBe('—');
    });

    it('handles pure input or pure output', () => {
      expect(calculateIoRatio(1000, 0)).toBe('纯输入');
      expect(calculateIoRatio(0, 500)).toBe('纯输出');
    });

    it('formats ratios correctly', () => {
      expect(calculateIoRatio(87000, 1000)).toBe('87:1');
      expect(calculateIoRatio(87200, 1000)).toBe('87.2:1');
      expect(calculateIoRatio(150, 100)).toBe('1.5:1');
    });
  });

  describe('calculateActiveDaysDailyAvg', () => {
    it('只使用当前查询的模型日桶，不使用云端年度背景热力图', () => {
      const models: Record<string, ModelStat> = {
        modelA: { name: 'modelA', total: 2500, requests: 2, heatmap: { '2026-09-01': 1000, '2026-09-03': 1500 } },
        modelB: { name: 'modelB', total: 1500, requests: 1, heatmap: { '2026-09-03': 1500 } },
      };
      expect(calculateActiveDaysDailyAvg(4000, models)).toEqual({ activeDaysCount: 2, dailyAvg: 2000 });
    });

    it('模型日桶缺失或与当前范围汇总不一致时不展示伪造日均', () => {
      expect(calculateActiveDaysDailyAvg(5000, {})).toBeNull();
      expect(calculateActiveDaysDailyAvg(5000, {
        modelA: { name: 'modelA', total: 4000, requests: 2, heatmap: { '2026-09-01': 4000 } },
      })).toBeNull();
    });
  });
});
