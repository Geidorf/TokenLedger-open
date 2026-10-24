import { useEffect, useState } from "react";
import { Smartphone } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import type { AppSettings, BusyState } from "../../types";
import { SettingsCard, SettingsGroup, SettingsToggleRow } from "./SettingsPrimitives";
import { t, useLang } from "../../i18n";

/** Mirrors `routing_publish::RoutingPublishStatus` (routing-snapshot-v1 §4). */
export interface RoutingPublishStatus {
  state: "off" | "signed-out" | "not-deployed" | "ok" | "error" | "starting";
  lastPublishedAt: string | null;
  flows: number;
  error: string | null;
}

const STATUS_POLL_MS = 5_000;

export function routingPublishStatusText(status: RoutingPublishStatus | null, enabled: boolean, now = Date.now()): string {
  if (!enabled) return t('publish.off');
  if (!status || status.state === "off" || status.state === "starting") return t('publish.starting');
  switch (status.state) {
    case "signed-out":
      return t('publish.signedOut');
    case "not-deployed":
      return t('publish.notDeployed');
    case "error":
      return status.error ? t('publish.errorDetail', { error: status.error }) : t('publish.error');
    case "ok": {
      const at = status.lastPublishedAt ? Date.parse(status.lastPublishedAt) : Number.NaN;
      const ago = Number.isFinite(at) ? Math.max(0, Math.round((now - at) / 1000)) : null;
      const when = ago === null ? "" : ago < 5 ? t('publish.justNow') : ago < 60 ? t('publish.secondsAgo', { count: ago }) : t('publish.minutesAgo', { count: Math.round(ago / 60) });
      return when ? t('publish.okWhen', { when, count: status.flows }) : t('publish.ok', { count: status.flows });
    }
    default:
      return "";
  }
}

interface RoutingPublishCardProps {
  appSettings: AppSettings;
  busy: BusyState;
  onSettingChange: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
}

/** 手机锁屏动态壁纸的数据来源：把实时路由经云端同步给 Android。 */
export function RoutingPublishCard({ appSettings, busy, onSettingChange }: RoutingPublishCardProps) {
  useLang();
  const enabled = appSettings.routing_publish_enabled === true;
  const [status, setStatus] = useState<RoutingPublishStatus | null>(null);

  useEffect(() => {
    if (!enabled) {
      setStatus(null);
      return undefined;
    }
    let cancelled = false;
    const read = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      invoke<RoutingPublishStatus>("routing_publish_status")
        .then((next) => {
          if (!cancelled) setStatus(next);
        })
        .catch(() => undefined);
    };
    read();
    const timer = setInterval(read, STATUS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [enabled]);

  return (
    <SettingsCard
      title={t('publish.title')}
      description={t('publish.description')}
    >
      <SettingsGroup>
        <SettingsToggleRow
          label={t('publish.toggle')}
          hint={routingPublishStatusText(status, enabled)}
          icon={Smartphone}
          checked={enabled}
          disabled={busy.settings}
          busy={busy.settings}
          onChange={(checked) => onSettingChange("routing_publish_enabled", checked)}
        />
      </SettingsGroup>
    </SettingsCard>
  );
}

export default RoutingPublishCard;
