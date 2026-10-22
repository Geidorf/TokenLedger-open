export type StatsRefreshUnlisten = () => void;

export function createVisibleStatsReconciler(
  visibilityState: () => string,
  reconcile: () => void,
  delayMs = 150,
): { request: () => boolean; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    request: () => {
      if (visibilityState() !== 'visible') return false;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        reconcile();
      }, delayMs);
      return true;
    },
    cancel: () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}

/**
 * Register the one-shot backend event before reading the current snapshot.
 *
 * Tauri events are not replayed. A startup scan can therefore finish before
 * React has attached its listener. Reconciling immediately after registration
 * closes that window without delaying background work or depending on a poll.
 */
export async function subscribeThenReconcile(
  subscribe: (onEvent: () => void) => Promise<StatsRefreshUnlisten>,
  onEvent: () => void,
  reconcile: () => void,
  isDisposed: () => boolean = () => false,
): Promise<StatsRefreshUnlisten | null> {
  const unlisten = await subscribe(() => {
    if (!isDisposed()) onEvent();
  });

  if (isDisposed()) {
    unlisten();
    return null;
  }

  reconcile();
  return unlisten;
}
