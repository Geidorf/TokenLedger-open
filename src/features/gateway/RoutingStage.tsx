import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  describeFlow,
  fitLabel,
  layoutRoutingScene,
  wirePath,
  type HopOutcome,
  type RoutingScene,
  type SceneFlow,
  type SceneNode,
} from './routingScene';
import './routingStage.css';

/** Seconds a packet takes along one wire, and the pause between hops. */
const HOP_SECONDS = 0.7;
const HOP_GAP = 0.25;
/** A whole replay (agent hop plus every member tried) fits in this many seconds; long failovers run faster. */
const MAX_REPLAY_SECONDS = 4;

/** Seconds between packet starts and each packet's run time for a flow with `hops` member hops. */
export function hopTiming(hops: number): { step: number; run: number; total: number } {
  const step = Math.min(HOP_SECONDS + HOP_GAP, MAX_REPLAY_SECONDS / (hops + 1));
  const run = step * (HOP_SECONDS / (HOP_SECONDS + HOP_GAP));
  return { step, run, total: step * hops + run };
}

/** Looping effects redraw this many times a second; enough for a 3–8px dash flow and a soft pulse. */
const LOOP_FPS = 12;
const DASH_PERIOD = 8;
const DASH_SECONDS = 0.7;
const PULSE_SECONDS = 1.2;
const RING_SECONDS = 1.8;

/** Which elements each looping value is set on: only these restyle on a tick, not the whole stage. */
const LOOP_TARGETS = {
  '--rs-dash': '.rs-wire.is-live',
  '--rs-pulse': '.rs-node.is-busy .rs-node-dot, .rs-held',
  '--rs-ring-width': '.rs-hub.is-busy circle',
  '--rs-ring-opacity': '.rs-hub.is-busy circle',
} as const;
type LoopProperty = keyof typeof LOOP_TARGETS;

/** The --rs-* values the looping effects read (routingStage.css) at `seconds` into the loop. */
export function loopFrame(seconds: number): Record<LoopProperty, string> {
  const dash = -Math.floor(((seconds % DASH_SECONDS) / DASH_SECONDS) * DASH_PERIOD);
  const pulse = 1 - 0.65 * (0.5 - 0.5 * Math.cos((2 * Math.PI * seconds) / PULSE_SECONDS));
  // The ring grows over the first 70% of its period (ease-out), then waits.
  const grow = Math.min(1, (seconds % RING_SECONDS) / (RING_SECONDS * 0.7));
  const eased = 1 - (1 - grow) ** 3;
  return {
    '--rs-dash': String(dash),
    '--rs-pulse': pulse.toFixed(2),
    '--rs-ring-width': (1.5 + 5.5 * eased).toFixed(2),
    '--rs-ring-opacity': (1 - 0.85 * eased).toFixed(2),
  };
}

/**
 * One timer drives every looping effect on the stage, a dozen times a
 * second, by setting CSS custom properties on the looping elements (no
 * React render). Infinite CSS keyframes cost a style recalc and repaint on
 * every display frame for as long as a request was in flight, which the
 * desktop widget can be for hours. Stops when nothing loops, when the
 * window is hidden, and under reduced motion (the static look stays).
 */
function useLoopClock(ref: { current: SVGSVGElement | null }, active: boolean) {
  useEffect(() => {
    const node = ref.current;
    if (!active || !node) return undefined;
    if (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;
    const started = Date.now();
    const tick = () => {
      if (document.visibilityState === 'hidden') return;
      const frame = loopFrame((Date.now() - started) / 1000);
      for (const name of Object.keys(LOOP_TARGETS) as LoopProperty[]) {
        for (const element of node.querySelectorAll<SVGElement>(LOOP_TARGETS[name])) {
          if (element.style.getPropertyValue(name) !== frame[name]) element.style.setProperty(name, frame[name]);
        }
      }
    };
    tick();
    const timer = window.setInterval(tick, 1000 / LOOP_FPS);
    return () => window.clearInterval(timer);
  }, [ref, active]);
}

export type StageVariant = 'page' | 'compact';

/** Below this width the page stage switches to the compact layout so labels stay legible. */
const COMPACT_BELOW = 560;

function useAutoVariant(requested: StageVariant | 'auto') {
  const ref = useRef<HTMLElement | null>(null);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (requested !== 'auto' || !node || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(([entry]) => setNarrow(entry.contentRect.width > 0 && entry.contentRect.width < COMPACT_BELOW));
    observer.observe(node);
    return () => observer.disconnect();
  }, [requested]);
  const variant: StageVariant = requested === 'auto' ? (narrow ? 'compact' : 'page') : requested;
  return { ref, variant };
}

const VARIANTS: Record<StageVariant, { width: number; rowGap: number; nodeWidth: number; nodeHeight: number; padding: number; maxLabel: number; hubRadius: number }> = {
  page: { width: 720, rowGap: 46, nodeWidth: 190, nodeHeight: 32, padding: 18, maxLabel: 22, hubRadius: 26 },
  compact: { width: 340, rowGap: 34, nodeWidth: 112, nodeHeight: 24, padding: 8, maxLabel: 13, hubRadius: 17 },
};

const FOLDED_TARGETS = '+targets';
const FOLDED_AGENTS = '+agents';

const SOURCE_LABEL = { tokenledger: 'TokenLedger 网关', external: '外部网关' } as const;

/** Chart slots that don't read as a status: red, green and amber stay for failed / ok / waiting. */
const AGENT_SLOTS = [1, 2, 7, 3];

/** Stable colour per agent from the shared chart palette (tokens.css). */
export function agentColor(agent: string): string {
  let hash = 0;
  for (const char of agent) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return `var(--chart-${AGENT_SLOTS[hash % AGENT_SLOTS.length]})`;
}

function hubLabel(scene: RoutingScene): string {
  const live = scene.sources.filter((source) => source.reachable).map((source) => SOURCE_LABEL[source.id]);
  return live.length > 0 ? live.join(' · ') : '网关';
}

function packetStyle(delay: number, run: number, color: string): CSSProperties {
  return { animationDelay: `${delay}s`, animationDuration: `${run}s`, '--agent': color } as CSSProperties;
}

function outcomeClass(outcome: HopOutcome): string {
  return outcome === 'ok' ? 'is-ok' : outcome === 'pending' ? 'is-pending' : outcome === 'skipped' ? 'is-skipped' : 'is-failed';
}

function NodeBox({ node, x, y, width, height, maxLabel, side, color }: {
  node: SceneNode;
  x: number;
  y: number;
  width: number;
  height: number;
  maxLabel: number;
  side: 'agent' | 'target';
  color?: string;
}) {
  const state = node.more ? 'more' : node.state ?? 'idle';
  return (
    <g className={`rs-node rs-${side} is-${state}`} transform={`translate(${x - width / 2} ${y - height / 2})`} style={color ? ({ '--agent': color } as CSSProperties) : undefined}>
      <title>{node.more ? `另有 ${node.more} 个` : node.why ? `${node.label} · ${node.why}` : node.label}</title>
      <rect className="rs-node-box" width={width} height={height} rx={height / 3.2} />
      {!node.more && <circle className="rs-node-dot" cx={12} cy={height / 2} r={3.5} />}
      <text className="rs-node-label" x={node.more ? width / 2 : 22} y={height / 2} textAnchor={node.more ? 'middle' : 'start'} dominantBaseline="central">
        {fitLabel(node.label, maxLabel)}
      </text>
      {side === 'target' && node.state === 'failed' && node.status ? (
        <g className="rs-tag" transform={`translate(${width - 30} ${-8})`}>
          <rect width={30} height={15} rx={4} />
          <text x={15} y={7.5} textAnchor="middle" dominantBaseline="central">{node.status}</text>
        </g>
      ) : null}
    </g>
  );
}

/**
 * The stage itself: pure SVG. Packets are one-shot CSS keyframes; a fresh
 * flow mounts its packets once (keyed by flow id), so a poll that returns the
 * same records does not replay them. Looping effects follow `useLoopClock`.
 */
export function RoutingStage({ scene, variant: requested = 'auto', title }: { scene: RoutingScene; variant?: StageVariant | 'auto'; title?: string }) {
  const { ref, variant } = useAutoVariant(requested);
  const spec = VARIANTS[variant];
  const layout = useMemo(() => layoutRoutingScene(scene, spec), [scene, spec]);
  const { hub } = layout;

  const agentColors = useMemo(() => new Map(scene.agents.map((node) => [node.id, agentColor(node.id)])), [scene.agents]);
  // A folded agent's requests start from its "+N" node.
  const sourceOf = (flow: SceneFlow) => (layout.agents.has(flow.agent) ? flow.agent : FOLDED_AGENTS);
  const fresh = scene.flows.filter((flow) => flow.fresh && layout.agents.has(sourceOf(flow)));

  // Freshness decides whether a flow starts playing; once started it stays
  // mounted until its last packet lands, even if it goes stale meanwhile.
  const playing = useRef(new Map<string, number>());
  const nowMs = Date.now();
  for (const [id, until] of playing.current) if (until < nowMs - 60_000) playing.current.delete(id);
  for (const flow of fresh) {
    if (flow.phase !== 'inflight' && !playing.current.has(flow.id)) playing.current.set(flow.id, nowMs + hopTiming(flow.hops.length).total * 1000);
  }
  const replays = scene.flows.filter((flow) => flow.phase === 'inflight' ? flow.fresh && layout.agents.has(sourceOf(flow)) : (playing.current.get(flow.id) ?? 0) >= nowMs && layout.agents.has(sourceOf(flow)));
  const caption = scene.flows[0] ? `${scene.flows[0].fresh ? '' : '最近：'}${describeFlow(scene.flows[0])}` : '';

  const liveAgents = new Set<string>();
  const litAgents = new Set<string>();
  const liveTargets = new Set<string>();
  const litTargets = new Map<string, HopOutcome>();
  for (const flow of fresh) {
    (flow.phase === 'inflight' ? liveAgents : litAgents).add(sourceOf(flow));
    for (const hop of flow.hops) {
      const node = layout.targets.has(hop.target) ? hop.target : FOLDED_TARGETS;
      if (flow.phase === 'inflight') liveTargets.add(node);
      else if (!litTargets.has(node)) litTargets.set(node, hop.outcome);
    }
  }

  const agentWire = (id: string) => {
    const point = layout.agents.get(id)!;
    return wirePath({ x: point.x + layout.nodeWidth / 2, y: point.y }, { x: hub.x - spec.hubRadius, y: hub.y });
  };
  const targetWire = (id: string) => {
    const point = layout.targets.get(id)!;
    return wirePath({ x: hub.x + spec.hubRadius, y: hub.y }, { x: point.x - layout.nodeWidth / 2, y: point.y });
  };

  const packets = (flow: SceneFlow) => {
    const color = agentColors.get(flow.agent) ?? 'var(--color-text-muted)';
    if (flow.phase === 'inflight') {
      return (
        <g key={flow.id} className="rs-flow is-inflight" style={{ '--agent': color } as CSSProperties}>
          <circle className="rs-held" cx={hub.x} cy={hub.y - spec.hubRadius - 6} r={3.5} />
        </g>
      );
    }
    // A member folded into "+N" still gets its hop, drawn to the fold node,
    // so the path always ends where the request actually went.
    const hops = flow.hops
      .map((hop) => ({ ...hop, node: layout.targets.has(hop.target) ? hop.target : FOLDED_TARGETS }))
      .filter((hop) => layout.targets.has(hop.node));
    const timing = hopTiming(hops.length);
    return (
      <g key={flow.id} className={`rs-flow is-${flow.phase}`}>
        <path className="rs-packet" d={agentWire(sourceOf(flow))} pathLength={100} style={packetStyle(0, timing.run, color)} />
        {hops.map((hop, index) => (
          <path
            key={`${hop.target}-${index}`}
            className={`rs-packet ${outcomeClass(hop.outcome)}`}
            d={targetWire(hop.node)}
            pathLength={100}
            style={packetStyle(timing.step * (index + 1), timing.run, color)}
          />
        ))}
      </g>
    );
  };

  const svgRef = useRef<SVGSVGElement | null>(null);
  useLoopClock(svgRef, liveAgents.size + liveTargets.size > 0 || scene.stats.inflight > 0
    || [...scene.agents, ...scene.targets].some((node) => node.state === 'busy'));

  const label = title ?? '实时路由动画';
  return (
    <figure ref={ref} className={`rs-stage is-${variant}`} aria-label={label}>
      <svg ref={svgRef} viewBox={`0 0 ${layout.width} ${layout.height}`} role="img" aria-label={`${label}：${scene.agents.length} 个 Agent，${scene.targets.length} 个上游`} preserveAspectRatio="xMidYMid meet">
        <g className="rs-wires" aria-hidden="true">
          {scene.agents.map((node) => (
            <path
              key={`a-${node.id}`}
              className={`rs-wire ${liveAgents.has(node.id) ? 'is-live' : litAgents.has(node.id) ? 'is-lit' : ''}`}
              style={{ '--agent': agentColors.get(node.id) } as CSSProperties}
              d={agentWire(node.id)}
            />
          ))}
          {scene.targets.map((node) => (
            <path
              key={`t-${node.id}`}
              className={`rs-wire ${liveTargets.has(node.id) ? 'is-live' : litTargets.has(node.id) ? `is-lit ${outcomeClass(litTargets.get(node.id)!)}` : ''}`}
              d={targetWire(node.id)}
            />
          ))}
        </g>
        <g className="rs-nodes">
          {scene.agents.map((node) => {
            const point = layout.agents.get(node.id)!;
            return <NodeBox key={node.id} node={node} x={point.x} y={point.y} width={layout.nodeWidth} height={layout.nodeHeight} maxLabel={spec.maxLabel} side="agent" color={agentColors.get(node.id)} />;
          })}
          {scene.targets.map((node) => {
            const point = layout.targets.get(node.id)!;
            return <NodeBox key={node.id} node={node} x={point.x} y={point.y} width={layout.nodeWidth} height={layout.nodeHeight} maxLabel={spec.maxLabel} side="target" />;
          })}
          <g className={`rs-hub ${scene.stats.inflight > 0 ? 'is-busy' : ''}`}>
            <title>{hubLabel(scene)}</title>
            <circle cx={hub.x} cy={hub.y} r={spec.hubRadius} />
            <path className="rs-hub-icon" transform={`translate(${hub.x - 9} ${hub.y - 9})`} d="M2 9h5l4-5h5M7 9l4 5h5M13.5 2l2.5 2-2.5 2M13.5 12l2.5 2-2.5 2" />
            {variant === 'page' && (
              <text className="rs-hub-label" x={hub.x} y={hub.y + spec.hubRadius + 14} textAnchor="middle">{fitLabel(hubLabel(scene), 28)}</text>
            )}
          </g>
        </g>
        <g className="rs-sky" aria-hidden="true">{replays.map(packets)}</g>
      </svg>
      <figcaption className="rs-caption" aria-live="polite">{caption}</figcaption>
    </figure>
  );
}

export function RoutingStageEmpty({ scene, variant = 'page' }: { scene: RoutingScene; variant?: StageVariant }) {
  const notes = scene.sources.filter((source) => !source.reachable && source.note).map((source) => source.note);
  const readFailed = scene.sources.some((source) => source.readError);
  return (
    <div className={`rs-empty is-${variant}`} role="status">
      {scene.empty === 'no-source' ? (
        <>
          <b>{readFailed ? '读取实时路由数据失败' : '暂无实时路由数据'}</b>
          <span>{notes.length > 0 ? `${notes.join('，')}。` : ''}{readFailed ? '会自动重试。' : '开启模型接入后，经过网关的请求会在这里实时显示路径与失败切换。'}</span>
        </>
      ) : (
        <>
          <b>还没有经过网关的请求</b>
          <span>Agent 发出请求后，这里会显示它走了哪条路、失败时切到了哪个成员。</span>
        </>
      )}
    </div>
  );
}
