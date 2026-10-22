import { describe, expect, it } from "vitest";
import {
  findSettingsDestinations,
  legacySettingsRedirect,
  settingsNavigationStatus,
  SETTINGS_DESTINATIONS,
  type SettingsNavigationState,
} from "./settingsNavigation";

function pricingState(pricing: Partial<SettingsNavigationState["pricing"]>): SettingsNavigationState {
  return {
    cloud: { configured: true, authenticated: true, capabilityVerified: true, firstSyncCompleted: true },
    quotaSyncStatus: { enabled: false, state: "disabled" },
    quotaProviders: [],
    appSettings: {
      quota_codex_local_enabled: false,
      quota_claude_statusline_enabled: false,
      quota_claude_codexbar_enabled: false,
      quota_antigravity_local_enabled: false,
      wallpaper_consent_version: 1,
      wallpaper_desktop_enabled: false,
      wallpaper_lockscreen_enabled: false,
      autostart_enabled: false,
      start_minimized: false,
      tray_hover_widget_enabled: false,
      widget_open_at_startup: false,
      desktop_widget_enabled: false,
    },
    pricing: { error: "", dirty: false, migrationNoticeOpen: false, ...pricing },
    dbInfo: null,
    dbInfoError: "",
  };
}

describe("「模型价格」目录徽章", () => {
  it("价格整理提示没关时挂「已整理」，与其他提醒同一种样式", () => {
    expect(settingsNavigationStatus("settings-pricing", pricingState({ migrationNoticeOpen: true })))
      .toEqual({ label: "已整理", tone: "attention" });
    expect(settingsNavigationStatus("settings-pricing", pricingState({})))
      .toEqual({ label: "已加载", tone: "ready" });
  });

  it("价格表坏了或有未保存的修改时，这两件事优先", () => {
    expect(settingsNavigationStatus("settings-pricing", pricingState({ migrationNoticeOpen: true, error: "价格表读取失败" })))
      .toEqual({ label: "需修复", tone: "attention" });
    expect(settingsNavigationStatus("settings-pricing", pricingState({ migrationNoticeOpen: true, dirty: true })))
      .toEqual({ label: "未保存", tone: "attention" });
  });
});

describe("「模型接入」分区（U-112）", () => {
  it("目录徽章跟随总开关", () => {
    const state = pricingState({});
    expect(settingsNavigationStatus("settings-model-access", state))
      .toEqual({ label: "已关闭", tone: "neutral" });
    const enabled = { ...state, appSettings: { ...state.appSettings, model_access_enabled: true } };
    expect(settingsNavigationStatus("settings-model-access", enabled))
      .toEqual({ label: "已开启", tone: "ready" });
  });

  it("搜网关或 CC Switch 只落到独立的模型接入分区", () => {
    expect(findSettingsDestinations("网关").map((item) => item.id)).toEqual(["settings-model-access"]);
    expect(findSettingsDestinations("cc switch").map((item) => item.id)).toEqual(["settings-model-access"]);
  });
});

describe("settings destinations", () => {
  it("把扫描、挂件与壁纸放在日常偏好的前面", () => {
    expect(SETTINGS_DESTINATIONS.map((item) => item.id).slice(0, 3)).toEqual([
      "settings-scan",
      "settings-widget",
      "settings-wallpaper",
    ]);
  });

  it("按分类词和用户可见名称检索", () => {
    // 托盘同时出现在两节：菜单栏文字属于托盘图标本身，托盘挂件是另一块窗口。
    expect(findSettingsDestinations("托盘").map((item) => item.id)).toEqual([
      "settings-scan",
      "settings-widget",
    ]);
    expect(findSettingsDestinations("账户").map((item) => item.id)).toContain(
      "settings-cloud",
    );
  });

  it("按设置项自己印着的字也能搜到", () => {
    // T10.127 的安装说明让用户去找「停留多久才弹出」，而搜索原来只看分区标题、
    // 描述和一份手写关键词，搜「停留」什么都搜不出来（T10.128 P1）。
    expect(findSettingsDestinations("停留").map((item) => item.id)).toEqual([
      "settings-widget",
    ]);
    expect(findSettingsDestinations("开机自动启动").map((item) => item.id))
      .toEqual(["settings-scan"]);
    expect(findSettingsDestinations("Publishable").map((item) => item.id))
      .toEqual(["settings-cloud"]);
  });

  it("每个分区都登记了自己的设置项，新增分区不能空着", () => {
    // items 是手工维护的：漏登记就等于那一节的控件在搜索里不存在。
    for (const destination of SETTINGS_DESTINATIONS) {
      expect(destination.items.length).toBeGreaterThan(0);
      for (const item of destination.items) {
        expect(findSettingsDestinations(item).map((entry) => entry.id))
          .toContain(destination.id);
      }
    }
  });

  it("菜单栏开关按新叫法「预估费用」检索，旧叫法「成本」不再出现（T10.154 D65）", () => {
    expect(findSettingsDestinations("预估费用").map((item) => item.id)).toEqual([
      "settings-scan",
    ]);
    expect(findSettingsDestinations("成本")).toEqual([]);
  });

  it("搜「项目」「工作目录」「隐私」落到数据与帮助（TOKE-13）", () => {
    for (const term of ["项目", "工作目录", "隐私", "按项目统计本机用量", "隐藏项目名"]) {
      expect(findSettingsDestinations(term).map((item) => item.id)).toContain("settings-data");
    }
  });

  it("搜「挂件」「小组件」都只落到桌面挂件这一节", () => {
    // 用户此前在目录里搜不到挂件，只能靠翻「扫描与启动」碰运气。
    for (const term of ["挂件", "小组件"]) {
      expect(findSettingsDestinations(term).map((item) => item.id)).toEqual([
        "settings-widget",
      ]);
    }
  });
});

describe("legacySettingsRedirect", () => {
  it("旧「API 配置」锚点改去 Agent 页，其余锚点不受影响", () => {
    expect(legacySettingsRedirect("#settings-api-profiles")).toBe("settings-model-access");
    expect(legacySettingsRedirect("settings-api-profiles")).toBe("settings-model-access");
    expect(legacySettingsRedirect("#api-profiles")).toBe("settings-model-access");
    expect(legacySettingsRedirect("#settings-cloud")).toBeNull();
    expect(legacySettingsRedirect("#gateway")).toBeNull();
    expect(legacySettingsRedirect("constructor")).toBeNull();
    expect(legacySettingsRedirect(undefined)).toBeNull();
    expect(SETTINGS_DESTINATIONS.some((item) => legacySettingsRedirect(item.id))).toBe(false);
  });
});
