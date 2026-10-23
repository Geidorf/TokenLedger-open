import { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { PeerLiveSnapshot } from '../../hooks/usePeerLive';
import { errorText, gatewayStatus, recentRequests, recentRouteDecisions } from './api';
import type { RoutingFeed } from './types';
import { buildRoutingScene, type ExternalLiveSnapshot, type RoutingScene, type SceneInput } from './routingScene';

export const ROUTING_POLL_MS = 1_500;
/** The ledger is read whole on the Rust side (up to 16 MB before rotation), so it is read less often than decisions. */
export const LEDGER_POLL_MS = 6_000;
const DECISION_LIMIT = 30;

export interface RoutingLiveOptions {
  enabled?: boolean;
  intervalMs?: number;
  /** Optional second source; omitted until the external gateway's live read is available. */
  readExternal?: () => Promise<ExternalLiveSnapshot>;
  /**
   * Reads the gateway in one call instead of status + decisions + ledger.
   * The widget windows pass `gateway_routing_feed` (the only gateway read
   * they are granted); the main window uses the full commands.
   */
  readFeed?: () => Promise<RoutingFeed>;
}

type GatewayInput = NonNullable<SceneInput['gateway']>;

/**
 * The external local gateway's live snapshot (`peer_live_snapshot`, contract
 * peer-live-v1; main window only). Not running is `reachable: false`, not an
 * error; a failed read rejects and the hook marks the source unreachable.
 */
export async function readExternalGateway(): Promise<ExternalLiveSnapshot> {
  return toExternalSnapshot(await invoke<PeerLiveSnapshot>('peer_live_snapshot', {}));
}

/** The scene keys flows by string id; the external gateway numbers its requests. */
export function toExternalSnapshot(snapshot: PeerLiveSnapshot): ExternalLiveSnapshot {
  return { ...snapshot, active: snapshot.active.map((request) => ({ ...request, id: String(request.id) })) };
}

async function readGateway(ledger: { at: number; requests: GatewayInput['requests'] }): Promise<GatewayInput> {
  const status = await gatewayStatus();
  if (!status.running) return { running: false, decisions: [], requests: [] };
  const due = Date.now() - ledger.at >= LEDGER_POLL_MS;
  const [decisions, requests] = await Promise.allSettled([recentRouteDecisions(DECISION_LIMIT), due ? recentRequests(DECISION_LIMIT) : Promise.resolve(ledger.requests)]);
  // The ledger only adds agent names and direct requests: if it can't be
  // read, keep the decisions and the last ledger read rather than going dark.
  if (due && requests.status === 'fulfilled') {
    ledger.at = Date.now();
    ledger.requests = requests.value;
  }
  if (decisions.status === 'rejected') return { running: true, decisions: [], requests: [], readError: errorText(decisions.reason) };
  return { running: true, decisions: decisions.value, requests: ledger.requests };
}

/**
 * Polls the gateway's own route decisions (and an external gateway's live snapshot when
 * given) while the page is visible, and ticks a clock so finished flows fade
 * out on time. A failed read turns its source unreachable; it never keeps
 * playing stale data as if it were live.
 */
export function useRoutingLive({ enabled = true, intervalMs = ROUTING_POLL_MS, readExternal, readFeed }: RoutingLiveOptions = {}): { scene: RoutingScene; error: string; loaded: boolean } {
  const [input, setInput] = useState<Omit<SceneInput, 'now'>>({});
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const externalRef = useRef(readExternal);
  externalRef.current = readExternal;
  const feedRef = useRef(readFeed);
  feedRef.current = readFeed;

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ledger: { at: number; requests: GatewayInput['requests'] } = { at: Number.NEGATIVE_INFINITY, requests: [] };

    const tick = async () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        timer = setTimeout(tick, intervalMs);
        return;
      }
      const readExt = externalRef.current;
      const feed = feedRef.current;
      const [gateway, external] = await Promise.allSettled([feed ? feed() : readGateway(ledger), readExt ? readExt() : Promise.resolve(null)]);
      if (cancelled) return;
      const next: Omit<SceneInput, 'now'> = {
        gateway: gateway.status === 'fulfilled' ? gateway.value : { running: false, decisions: [], requests: [], readError: errorText(gateway.reason) },
        external: external.status === 'fulfilled' ? external.value : readExt ? { reachable: false, active: [] } : null,
      };
      setInput(next);
      setError(gateway.status === 'rejected' ? errorText(gateway.reason) : '');
      setNow(Date.now());
      setLoaded(true);
      timer = setTimeout(tick, intervalMs);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [enabled, intervalMs]);

  const scene = useMemo(() => buildRoutingScene({ ...input, now }), [input, now]);
  return { scene, error, loaded };
}
