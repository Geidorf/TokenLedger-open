import { useEffect, useState } from "react";
import { Gauge, Layers, MessagesSquare } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import type { AppSettings, BusyState } from "../../types";
import { SettingsCard, SettingsGroup, SettingsToggleRow } from "./SettingsPrimitives";

/** Mirrors `usage_dimensions_publish::DimensionStatus` (usage-dimensions-cloud-v1 §5). */
export interface UsageDimensionStatus {
  state: "off" | "signed-out" | "not-deployed" | "ok" | "error" | "starting";
  lastUploadedAt: string | null;
  error: string | null;
}

export interface UsageDimensionsStatus {
  sessions: UsageDimensionStatus;
  providers: UsageDimensionStatus;
  context: UsageDimensionStatus;
}

export type UsageDimensionKey = keyof UsageDimensionsStatus;

type DimensionSettingKey =
  | "usage_dimension_sessions_enabled"
  | "usage_dimension_providers_enabled"
  | "usage_dimension_context_enabled";

interface DimensionSpec {
  key: UsageDimensionKey;
  setting: DimensionSettingKey;
  label: string;
  fields: string;
  icon: LucideIcon;
}

export const USAGE_DIMENSIONS: DimensionSpec[] = [
  {
    key: "sessions",
    setting: "usage_dimension_sessions_enabled",
    label: "会话列表",
    fields: "每天每个会话的 Token、记录数、费用、首末时间（到分钟）和主要模型；会话 ID 先在本机加密成不可还原的编号。",
    icon: MessagesSquare,
  },
  {
    key: "providers",
    setting: "usage_dimension_providers_enabled",
    label: "按账号拆分",
    fields: "每天经网关的各供应商用量；只上传内置的官方供应商名，自建账号一律记为「其他」。",
    icon: Layers,
  },
  {
    key: "context",
    setting: "usage_dimension_context_enabled",
    label: "平均 Context 构成",
    fields: "每天经网关请求的系统提示、工具、历史、附件等各部分字节数与条数合计。",
    icon: Gauge,
  },
];

const STATUS_POLL_MS = 10_000;

function ago(iso: string | null, now: number): string {
  const at = iso ? Date.parse(iso) : Number.NaN;
  if (!Number.isFinite(at)) return "";
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 10) return "刚刚";
  if (seconds < 60) return `${seconds} 秒前`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} 分钟前`;
  return `${Math.round(seconds / 3600)} 小时前`;
}

/** 开关旁的一行说明：关闭时说明会上传什么，开启后说明同步状态。 */
export function usageDimensionHint(
  spec: Pick<DimensionSpec, "fields">,
  status: UsageDimensionStatus | null,
  enabled: boolean,
  now = Date.now(),
): string {
  if (!enabled) return `开启后上传：${spec.fields}关闭时删除云端这一项的全部数据。`;
  if (!status || status.state === "off" || status.state === "starting") {
    return "正在准备，首次会补传最近 90 天。";
  }
  switch (status.state) {
    case "signed-out":
      return "需要先在「云端同步」登录账户，手机端登录同一个账户才能看到。";
    case "not-deployed":
      return "云端尚未开通用量维度（需要执行一次数据库迁移），5 分钟后自动重试，其他同步不受影响。";
    case "error":
      return `上传失败，稍后自动重试${status.error ? `：${status.error}` : ""}`;
    case "ok": {
      const when = ago(status.lastUploadedAt, now);
      return `已同步${when ? `（${when}）` : ""}。云端只保留最近 90 天，随云同步自动更新。`;
    }
    default:
      return "";
  }
}

interface UsageDimensionsCardProps {
  appSettings: AppSettings;
  busy: BusyState;
  onSettingChange: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
}

/** 「数据与帮助」里的用量维度上传：会话、账号与 Context 构成，供 Android 只读查看。 */
export function UsageDimensionsCard({ appSettings, busy, onSettingChange }: UsageDimensionsCardProps) {
  const anyEnabled = USAGE_DIMENSIONS.some((spec) => appSettings[spec.setting] === true);
  const [status, setStatus] = useState<UsageDimensionsStatus | null>(null);

  useEffect(() => {
    if (!anyEnabled) {
      setStatus(null);
      return undefined;
    }
    let cancelled = false;
    const read = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      invoke<UsageDimensionsStatus>("usage_dimensions_publish_status")
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
  }, [anyEnabled]);

  return (
    <SettingsCard
      title="同步用量维度到手机"
      description="Android 看板默认只有总量。这三项各自独立、默认关闭，只上传按天汇总的大小与计数，不上传提示词、回复、文件路径或凭据。"
    >
      <SettingsGroup>
        {USAGE_DIMENSIONS.map((spec) => {
          const enabled = appSettings[spec.setting] === true;
          return (
            <SettingsToggleRow
              key={spec.key}
              label={spec.label}
              hint={usageDimensionHint(spec, status?.[spec.key] ?? null, enabled)}
              icon={spec.icon}
              checked={enabled}
              disabled={busy.settings}
              busy={busy.settings}
              onChange={(checked) => onSettingChange(spec.setting, checked)}
            />
          );
        })}
      </SettingsGroup>
    </SettingsCard>
  );
}

export default UsageDimensionsCard;
