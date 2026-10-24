import { describe, expect, it } from 'vitest';
import { contextComposition } from './contextComposition';

const context = { systemBytes: 100, toolsBytes: 300, historyBytes: 0, toolResultsBytes: 600, attachmentsBytes: 0, messages: 2, toolResults: 1, attachments: 0 };

describe('contextComposition', () => {
  it('按字节占比分摊实测输入，只列字节数为正的分段', () => {
    expect(contextComposition(context, 2000)).toEqual([
      { key: 'systemBytes', label: '系统提示', bytes: 100, share: 0.1, estimatedTokens: 200 },
      { key: 'toolsBytes', label: '工具定义', bytes: 300, share: 0.3, estimatedTokens: 600 },
      { key: 'toolResultsBytes', label: '工具结果', bytes: 600, share: 0.6, estimatedTokens: 1200 },
    ]);
  });

  it('没有实测输入时只给占比；没有构成或全为 0 时不可得', () => {
    expect(contextComposition(context, 0)?.map((segment) => segment.estimatedTokens)).toEqual([null, null, null]);
    expect(contextComposition(undefined, 100)).toBeNull();
    expect(contextComposition({ ...context, systemBytes: 0, toolsBytes: 0, toolResultsBytes: 0 }, 100)).toBeNull();
  });
});
