import { describe, expect, it } from 'vitest';
import { routingPublishStatusText, type RoutingPublishStatus } from './RoutingPublishCard';

const base: RoutingPublishStatus = { state: 'ok', lastPublishedAt: null, flows: 0, error: null };

describe('routingPublishStatusText', () => {
  it('says nothing is uploaded while off', () => {
    expect(routingPublishStatusText({ ...base, state: 'ok' }, false)).toContain('不上传');
  });

  it('reports each state honestly', () => {
    expect(routingPublishStatusText({ ...base, state: 'signed-out' }, true)).toContain('登录');
    expect(routingPublishStatusText({ ...base, state: 'not-deployed' }, true)).toContain('尚未部署');
    expect(routingPublishStatusText({ ...base, state: 'error', error: 'HTTP 502' }, true)).toContain('HTTP 502');
    expect(routingPublishStatusText(null, true)).toContain('准备');
  });

  it('shows how long ago the last publish was', () => {
    const now = Date.parse('2026-10-24T07:00:00Z');
    const text = routingPublishStatusText({ ...base, lastPublishedAt: '2026-10-24T06:59:30Z', flows: 3 }, true, now);
    expect(text).toContain('30 秒前');
    expect(text).toContain('3 条');
  });
});
