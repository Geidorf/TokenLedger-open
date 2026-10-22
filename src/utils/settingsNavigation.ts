import type {
  AppSettings,
  DbInfo,
  QuotaProviderEnvelope,
  QuotaSyncStatus,
} from "../types";

export type SettingsNavigationStatusTone = "attention" | "ready" | "neutral";

export interface SettingsNavigationStatus {
  label: string;
  tone: SettingsNavigationStatusTone;
}

export type SettingsDestinationIcon =
  "Cloud" | "CircleGauge" | "Sliders" | "ImageIcon" | "DollarSign" | "Database" | "AppWindow" | "Route";
export interface SettingsDestination {
  id: string;
  label: string;
  description: string;
  keywords: string[];
  /**
   * 分区里那些设置项自己印着的字。搜索原来只看 label/description/keywords，
   * 于是「停留」搜不到「停留多久才弹出」——用户按控件上的字去搜是最自然的做法，
   * 却什么都搜不出来（T10.128 P1）。新增设置项时请把它的 label 加进来。
   */
  items: string[];
  icon: SettingsDestinationIcon;
}

/** 目录的顺序也是设置的产品优先级：先日常偏好，再账户与低频管理。 */
export const SETTINGS_DESTINATIONS: SettingsDestination[] = [
  {
    id: "settings-scan",
    items: [
    "扫描本地日志", "扫描间隔", "开机自动启动", "启动时最小化到托盘", "菜单栏显示今日预估费用",
    ],
    label: "扫描与启动",
    description: "扫描频率、启动与菜单栏",
    keywords: ["常用", "日志", "托盘", "菜单栏", "开机"],
    icon: "Sliders",
  },
  {
    id: "settings-widget",
    items: [
    "指向托盘图标时弹出", "停留多久才弹出", "启动时直接钉住托盘挂件", "在桌面上常驻小组件", "板式", "主题", "默认范围",
    "额度来源",
    ],
    label: "桌面挂件",
    description: "托盘挂件与桌面小组件",
    keywords: ["常用", "托盘", "挂件", "小组件", "悬停", "常驻"],
    icon: "AppWindow",
  },
  {
    id: "settings-wallpaper",
    items: [
    "启用桌面壁纸", "桌面壁纸刷新间隔", "自动更新锁屏壁纸", "锁屏壁纸刷新", "壁纸效果预览", "壁纸用量来源",
    "壁纸统计设备范围",
    ],
    label: "桌面壁纸",
    description: "桌面与锁屏自动化",
    keywords: ["常用", "动态背景", "锁屏", "预览"],
    icon: "ImageIcon",
  },
  {
    id: "settings-cloud",
    items: [
    "Supabase URL", "Publishable Key", "邮箱", "密码", "登录状态", "修改连接配置",
    "跨设备同步状态",
    ],
    label: "云端账户",
    description: "连接、登录与同步",
    keywords: ["账户", "同步", "supabase"],
    icon: "Cloud",
  },
  {
    id: "settings-quota",
    items: [
    "Claude 接入方式", "允许读取 Claude Code 额度快照", "授权读取 Claude 订阅额度",
    "statusLine 配置", "内置 /usage 探针", "允许读取本机 Codex 额度",
    "允许读取本机 Antigravity 额度", "Antigravity 使用 CodexBar 兜底", "公司额度来源名称",
    "公司额度查询接口地址", "公司额度 API key", "同步脱敏额度快照到我的设备", "云端额度快照管理",
    ],
    label: "订阅额度",
    description: "本地授权与额度同步",
    keywords: ["账户", "codex", "claude", "antigravity"],
    icon: "CircleGauge",
  },
  {
    id: "settings-model-access",
    items: ["模型接入"],
    label: "模型接入",
    description: "网关、供应商、Agent 与路由",
    keywords: ["网关", "供应商", "路由", "Agent", "CC Switch"],
    icon: "Route",
  },
  {
    id: "settings-pricing",
    items: [
    "模型价格 JSON", "价格表显示方式", "模型价格",
    ],
    label: "模型价格",
    description: "价格表与核价",
    keywords: ["数据", "费用", "美元", "models.dev"],
    icon: "DollarSign",
  },
  {
    id: "settings-data",
    items: [
    "删除该日期之前的记录", "清理截止日期", "可回收空间", "数据库体积", "总记录", "时间跨度",
    "按项目统计本机用量", "隐藏项目名",
    ],
    label: "数据与帮助",
    description: "导出、清理与数据库",
    keywords: ["数据", "csv", "回收", "战报", "项目", "工作目录", "隐私"],
    icon: "Database",
  },
];

/**
 * 旧 API 配置锚点进入恢复设置；总开关关闭时也能处理旧恢复凭据。
 */
const LEGACY_SETTINGS_REDIRECTS: Readonly<Record<string, "settings-model-access">> = {
  "settings-api-profiles": "settings-model-access",
  "api-profiles": "settings-model-access",
};

export function legacySettingsRedirect(anchor: string | null | undefined): "settings-model-access" | null {
  const key = (anchor ?? "").replace(/^#/, "");
  return Object.prototype.hasOwnProperty.call(LEGACY_SETTINGS_REDIRECTS, key)
    ? LEGACY_SETTINGS_REDIRECTS[key]
    : null;
}

export function findSettingsDestinations(query: string): SettingsDestination[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return SETTINGS_DESTINATIONS;
  return SETTINGS_DESTINATIONS.filter((destination) =>
    [
      destination.label,
      destination.description,
      ...destination.keywords,
      ...destination.items,
    ]
      .join(" ")
      .toLocaleLowerCase()
      .includes(normalized),
  );
}

export interface SettingsNavigationState {
  cloud: {
    configured: boolean;
    authenticated: boolean;
    capabilityVerified: boolean;
    firstSyncCompleted: boolean;
  };
  quotaSyncStatus: Pick<QuotaSyncStatus, "enabled" | "state">;
  quotaProviders: Array<Pick<QuotaProviderEnvelope, "providerId" | "status">>;
  appSettings: Pick<
    AppSettings,
    | "quota_codex_local_enabled"
    | "quota_claude_statusline_enabled"
    | "quota_claude_codexbar_enabled"
    | "quota_antigravity_local_enabled"
    | "wallpaper_consent_version"
    | "wallpaper_desktop_enabled"
    | "wallpaper_lockscreen_enabled"
    | "autostart_enabled"
    | "start_minimized"
    | "tray_hover_widget_enabled"
    | "widget_open_at_startup"
    | "desktop_widget_enabled"
    | "model_access_enabled"
  >;
  pricing: {
    error: string;
    dirty: boolean;
    /**
     * 「设置 → 模型价格」顶部的价格整理提示还开着（没点「知道了，不再提示」）。
     * 多数人很久才会打开这一节，目录上挂「已整理」，提示才不会一直没人看到
     * （T10.189 评审 §9 第 2 点，T10.202）。
     */
    migrationNoticeOpen: boolean;
  };
  dbInfo: Pick<DbInfo, "unsyncedRecords"> | null;
  /**
   * 读取数据库信息失败时的错误文案。没有它的话，`dbInfo` 为 null 这一个状态
   * 同时表示「正在读」和「读失败了」，目录徽章就会在失败后永远停在「读取中」——
   * 面板里明明已经显示了错误，目录却在骗人。
   */
  dbInfoError: string;
}

function pendingDataStatusLabel(
  unsyncedRecords: number,
  cloud: SettingsNavigationState["cloud"],
): string {
  const countLabel = `${unsyncedRecords}条`;
  if (!cloud.configured) return `先配置 · ${countLabel}`;
  if (!cloud.authenticated) return `先登录 · ${countLabel}`;
  if (!cloud.capabilityVerified) return `先验证 · ${countLabel}`;
  if (!cloud.firstSyncCompleted) return `首次同步 · ${countLabel}`;
  return `${unsyncedRecords} 条待同步`;
}

export function settingsNavigationStatus(
  id: string,
  state: SettingsNavigationState,
): SettingsNavigationStatus | null {
  switch (id) {
    case "settings-cloud":
      if (!state.cloud.configured)
        return { label: "未配置", tone: "attention" };
      if (!state.cloud.authenticated)
        return { label: "未登录", tone: "attention" };
      if (!state.cloud.capabilityVerified)
        return { label: "待验证", tone: "attention" };
      if (!state.cloud.firstSyncCompleted)
        return { label: "待同步", tone: "attention" };
      return { label: "已就绪", tone: "ready" };
    case "settings-quota": {
      const localEnabledCount = [
        state.appSettings.quota_codex_local_enabled,
        state.appSettings.quota_claude_statusline_enabled ||
          state.appSettings.quota_claude_codexbar_enabled,
        state.appSettings.quota_antigravity_local_enabled,
      ].filter(Boolean).length;
      if (state.quotaSyncStatus.state === "error")
        return { label: "需处理", tone: "attention" };
      if (state.quotaSyncStatus.state === "auth-required")
        return { label: "待登录", tone: "attention" };
      if (state.quotaSyncStatus.state === "syncing")
        return { label: "同步中", tone: "neutral" };
      if (
        state.quotaSyncStatus.enabled &&
        state.quotaSyncStatus.state === "active"
      )
        return { label: "已同步", tone: "ready" };
      const companySnapshotCount = state.quotaProviders.filter(
        (provider) =>
          provider.providerId.startsWith("company-openapi-") &&
          (provider.status === "ok" || provider.status === "stale"),
      ).length;
      if (companySnapshotCount > 0)
        return { label: `${companySnapshotCount} 个来源`, tone: "ready" };
      return localEnabledCount > 0
        ? { label: `${localEnabledCount} 个启用`, tone: "ready" }
        : { label: "待授权", tone: "neutral" };
    }
    case "settings-scan":
      return state.appSettings.start_minimized
        ? { label: "已配置", tone: "ready" }
        : { label: "默认", tone: "neutral" };
    case "settings-model-access":
      return state.appSettings.model_access_enabled === true
        ? { label: "已开启", tone: "ready" }
        : { label: "已关闭", tone: "neutral" };
    case "settings-widget": {
      // 徽章要能一眼看出「现在到底有几块挂件会出现」，所以按两块分别报，
      // 而不是把开关数加起来——启动时钉住只是托盘挂件的一个附加行为。
      const tray = state.appSettings.tray_hover_widget_enabled ||
        state.appSettings.widget_open_at_startup;
      const desktop = state.appSettings.desktop_widget_enabled;
      if (tray && desktop) return { label: "托盘+桌面", tone: "ready" };
      if (tray) return { label: "仅托盘", tone: "ready" };
      if (desktop) return { label: "仅桌面", tone: "ready" };
      return { label: "已关闭", tone: "neutral" };
    }
    case "settings-wallpaper":
      if (state.appSettings.wallpaper_consent_version < 1)
        return { label: "需确认", tone: "attention" };
      return state.appSettings.wallpaper_desktop_enabled ||
        state.appSettings.wallpaper_lockscreen_enabled
        ? { label: "已启用", tone: "ready" }
        : { label: "已暂停", tone: "neutral" };
    case "settings-pricing":
      if (state.pricing.error) return { label: "需修复", tone: "attention" };
      if (state.pricing.dirty) return { label: "未保存", tone: "attention" };
      if (state.pricing.migrationNoticeOpen)
        return { label: "已整理", tone: "attention" };
      return { label: "已加载", tone: "ready" };
    case "settings-data":
      if (state.dbInfoError) return { label: "读取失败", tone: "attention" };
      if (!state.dbInfo) return { label: "读取中", tone: "neutral" };
      return state.dbInfo.unsyncedRecords > 0
        ? {
            label: pendingDataStatusLabel(
              state.dbInfo.unsyncedRecords,
              state.cloud,
            ),
            tone: "attention",
          }
        : { label: "无待同步", tone: "ready" };
    default:
      return null;
  }
}
