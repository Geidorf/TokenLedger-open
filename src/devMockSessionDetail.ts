import type { LogHistoryItem } from './types';

/**
 * Preview-only session for the session detail page: one Claude session that
 * went through the local gateway, with model switches, cache splits, request
 * timing and context composition. The main preview ledger has one row per
 * session, so this fixture is served only when the details search asks for
 * its exact ID (`#session/claude/preview-session-refactor`).
 */
export const SESSION_DETAIL_FIXTURE_ID = 'preview-session-refactor';

const MODELS = ['claude-sonnet-4', 'claude-sonnet-4', 'claude-opus-4-1', 'claude-sonnet-4'] as const;
/** Request index where each model block starts (the session switches three times). */
const MODEL_BLOCKS = [0, 9, 17, 26];
const ROWS = 34;

function modelAt(index: number): string {
  let block = 0;
  MODEL_BLOCKS.forEach((start, position) => { if (index >= start) block = position; });
  return MODELS[block];
}

/** Deterministic rows ending a few minutes before `now`, oldest first. */
export function sessionDetailFixtureRows(now: Date): LogHistoryItem[] {
  const end = now.getTime() - 4 * 60_000;
  const start = end - 102 * 60_000;
  return Array.from({ length: ROWS }, (_, index) => {
    const model = modelAt(index);
    const opus = model.includes('opus');
    const wave = Math.sin(index * 1.7) * 0.5 + 0.5;
    const history = 18_000 + index * 4_600;
    const toolResults = 6_000 + Math.round(wave * 22_000) + (index > 20 ? 14_000 : 0);
    const system = 11_500;
    const tools = 23_800;
    const attachments = index === 12 || index === 13 ? 42_000 : 0;
    const promptBytes = system + tools + history + toolResults + attachments;
    const prompt = Math.round(promptBytes / 3.6);
    const cacheRead = index === 0 || index === 17 ? 0 : Math.round(prompt * (0.62 + wave * 0.24));
    const cacheWrite = index === 0 || index === 17 ? Math.round(prompt * 0.7) : Math.round(prompt * 0.04);
    const inputTokens = Math.max(400, prompt - cacheRead - cacheWrite);
    const outputTokens = 600 + Math.round(wave * 2_800) + (opus ? 1_400 : 0);
    const inPrice = opus ? 15 : 3;
    const outPrice = opus ? 75 : 15;
    const cost = (inputTokens * inPrice + outputTokens * outPrice + cacheRead * inPrice * 0.1 + cacheWrite * inPrice * 1.25) / 1_000_000;
    const at = start + Math.round((index / (ROWS - 1)) * (end - start)) + (index % 3) * 17_000;
    return {
      id: 900_000 + index,
      tool: 'claude',
      model,
      inputTokens,
      outputTokens,
      cachedTokens: cacheRead + cacheWrite,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      cost: Number(cost.toFixed(6)),
      timestamp: new Date(at).toISOString(),
      sessionId: SESSION_DETAIL_FIXTURE_ID,
      machineId: 'Studio-PC',
      granularity: 'request' as const,
      source: 'gateway',
      provider: 'preview-provider',
      latencyMs: 2_400 + Math.round(wave * 9_000) + (opus ? 6_500 : 0),
      context: {
        systemBytes: system,
        toolsBytes: tools,
        historyBytes: history,
        toolResultsBytes: toolResults,
        attachmentsBytes: attachments,
        messages: 4 + index * 2,
        toolResults: Math.floor(index * 1.5),
        attachments: attachments ? 1 : 0,
      },
    };
  });
}
