import { useEffect, useState } from "react";
import { Smartphone } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import type { AppSettings, BusyState } from "../../types";
import { SettingsCard, SettingsGroup, SettingsToggleRow } from "./SettingsPrimitives";

/** Mirrors `routing_publish::RoutingPublishStatus` (routing-snapshot-v1 §4). */
export interface RoutingPublishStatus {
  state: "off" | "signed-out" | "not-deployed" | "ok" | "error" | "starting";
  lastPublishedAt: string | null;
  flows: number;
  error: string | null;
}

const STATUS_POLL_MS = 5_000;

export function routingPublishStatusText(status: RoutingPublishStatus | null, enabled: boolean, now = Date.now()): string {
  if (!enabled) return "关闭时不上传任何路由数据，并删除云端本机那一份快照。";
  if (!status || status.state === "off" || status.state === "starting") return "正在准备，几秒后开始同步。";
  switch (status.state) {
    case "signed-out":
      return "需要先在「云端同步」登录账户，手机端登录同一个账户才能看到。";
    case "not-deployed":
      return "云端尚未部署实时路由同步（需要执行一次数据库迁移），其他同步不受影响。";
    case "error":
      return `同步失败，稍后自动重试${status.error ? `：${status.error}` : ""}`;
    case "ok": {
      const at = status.lastPublishedAt ? Date.parse(status.lastPublishedAt) : Number.NaN;
      const ago = Number.isFinite(at) ? Math.max(0, Math.round((now - at) / 1000)) : null;
      const when = ago === null ? "" : ago < 5 ? "刚刚" : ago < 60 ? `${ago} 秒前` : `${Math.round(ago / 60)} 分钟前`;
      return `已同步${when ? `（${when}）` : ""}，当前 ${status.flows} 条路由记录。只上传 Agent 名、供应商/模型和状态码。`;
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
      title="手机动态壁纸"
      description="Android 锁屏动态壁纸显示这台电脑网关的实时路由，延迟几秒到一分钟。"
    >
      <SettingsGroup>
        <SettingsToggleRow
          label="把实时路由同步到手机"
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
