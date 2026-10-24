import assert from 'node:assert/strict';
import test from 'node:test';
import { formatSummary, median, parseGfxinfo, parseRuns, parseScreenSize, parseTotalTime } from './android-perf-probe.mjs';

test('reads TotalTime from am start -W', () => {
  const output = 'Starting: Intent { cmp=x/.MainActivity }\nStatus: ok\nLaunchState: COLD\nActivity: x/.MainActivity\nTotalTime: 812\nWaitTime: 830\nComplete\n';
  assert.equal(parseTotalTime(output), 812);
  assert.equal(parseTotalTime('Error: Activity not started'), null);
});

test('reads the gfxinfo summary block', () => {
  const output = [
    'Stats since: 123ns',
    'Total frames rendered: 412',
    'Janky frames: 37 (8.98%)',
    '50th percentile: 9ms',
    '90th percentile: 17ms',
    '95th percentile: 23ms',
    '99th percentile: 41ms',
  ].join('\n');
  assert.deepEqual(parseGfxinfo(output), {
    totalFrames: 412,
    jankyFrames: 37,
    jankyPercent: 8.98,
    p50Ms: 9,
    p90Ms: 17,
    p95Ms: 23,
    p99Ms: 41,
  });
  assert.equal(parseGfxinfo('nothing here').totalFrames, null);
});

test('median ignores missing samples', () => {
  assert.equal(median([300, 100, 200]), 200);
  assert.equal(median([400, 100, 200, 300]), 250);
  assert.equal(median([]), null);
});

test('screen size prefers the override', () => {
  assert.deepEqual(parseScreenSize('Physical size: 1080x2400\n'), { width: 1080, height: 2400 });
  assert.deepEqual(parseScreenSize('Physical size: 1080x2400\nOverride size: 720x1600\n'), { width: 720, height: 1600 });
});

test('summary shows a dash for anything that was not measured', () => {
  const summary = formatSummary({
    device: 'sdk_gphone64_x86_64 · API 34 · 1080x2400',
    runs: 10,
    coldStartMain: { medianMs: 640 },
    coldStartRequests: { medianMs: null },
    scroll: { totalFrames: 412, jankyFrames: 37, jankyPercent: 8.98, p50Ms: 9, p90Ms: 17, p99Ms: 41 },
    routing: { seconds: 10, framesPerSecond: 30.1 },
  });
  assert.match(summary, /640 ms/u);
  assert.match(summary, /「请求」页首帧（预览夹具，中位数） \| — \|/u);
  assert.match(summary, /30\.1/u);
});

test('accepts only whole run counts from 1 to 50', () => {
  assert.equal(parseRuns('10'), 10);
  assert.equal(parseRuns('1'), 1);
  assert.equal(parseRuns('50'), 50);
  for (const bad of ['0', '51', '-3', '2.5', 'abc', '']) {
    assert.equal(parseRuns(bad), null, bad);
  }
});
