import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { SettingsTab } from "./SettingsTab";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

vi.mock("./settings/ScanStartupSection", () => ({
  ScanStartupSection: () => (
    <div id="settings-scan" tabIndex={-1}>
      扫描内容
    </div>
  ),
}));
vi.mock("./settings/WidgetSection", () => ({
  WidgetSection: () => (
    <div id="settings-widget" tabIndex={-1}>
      挂件内容
    </div>
  ),
}));
vi.mock("./settings/WallpaperSection", () => ({
  WallpaperSection: () => (
    <div id="settings-wallpaper" tabIndex={-1}>
      壁纸内容
    </div>
  ),
}));
vi.mock("./settings/CloudAccountSection", () => ({
  CloudAccountSection: () => (
    <div id="settings-cloud" tabIndex={-1}>
      账户内容
    </div>
  ),
}));
vi.mock("./settings/QuotaSection", () => ({
  QuotaSection: () => (
    <div id="settings-quota" tabIndex={-1}>
      额度内容
    </div>
  ),
}));
// The real price section shows the cleanup notice first; keep that one real so
// the directory badge is tested against what the notice reports.
vi.mock("./settings/PricingSection", async () => {
  const { PriceMigrationNotice } = await import("./settings/PriceMigrationNotice");
  return {
    PricingSection: () => (
      <div id="settings-pricing" tabIndex={-1}>
        <PriceMigrationNotice />
        价格内容
      </div>
    ),
  };
});
vi.mock("./settings/DataHelpSection", () => ({
  DataHelpSection: () => (
    <div id="settings-data" tabIndex={-1}>
      数据内容
    </div>
  ),
}));

const props = {
  cloud: {
    setup: {
      configured: false,
      authenticated: false,
      capabilityVerified: false,
      firstSyncCompleted: false,
    },
  },
  quota: {
    quotaSyncStatus: { enabled: false, state: "inactive" },
    quotaProviders: [],
  },
  wallpaper: {},
  widget: {},
  scanStartup: {
    appSettings: {
      scan_interval_secs: 900,
      autostart_enabled: false,
      start_minimized: false,
      quota_codex_local_enabled: false,
      quota_claude_statusline_enabled: false,
      quota_claude_codexbar_enabled: false,
      quota_antigravity_local_enabled: false,
      wallpaper_consent_version: 1,
      wallpaper_desktop_enabled: false,
      wallpaper_lockscreen_enabled: false,
      tray_hover_widget_enabled: true,
      widget_open_at_startup: false,
      desktop_widget_enabled: false,
    },
    onFlushSettingChange: vi.fn(),
  },
  pricing: { pricesError: "", pricesLoadError: "", pricesDirty: false },
  dataHelp: { dbInfo: null, dbInfoError: "" },
} as unknown as React.ComponentProps<typeof SettingsTab>;

const PRICE_NOTICE = {
  id: "a3f1c2d4e5b60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
  migratedAt: "2026-09-25T10:30:00Z",
  backupFile: "prices.legacy-backup-a3f1c2d4e5b6.json",
  backupDir: "C:\\Users\\demo\\AppData\\Roaming\\com.jeidorf.tokenledger",
  modelsCleared: 2,
  fieldsCleared: 3,
  cleared: [
    { model: "claude-sonnet-5", fields: ["input", "output"], wholeModel: true },
    { model: "gpt-4.1", fields: ["output"], wholeModel: false },
  ],
  changed: [
    { model: "claude-sonnet-5", field: "input", previous: 3, current: 2 },
    { model: "claude-sonnet-5", field: "output", previous: 15, current: 10 },
  ],
};

/** The backend's two notice commands; the notice goes away once dismissed. */
function priceNoticeBackend(notice: typeof PRICE_NOTICE | null) {
  let dismissed = false;
  vi.mocked(invoke).mockImplementation(async (command: string) => {
    if (command === "get_price_migration_notice") return dismissed ? null : notice;
    if (command === "dismiss_price_migration_notice") {
      dismissed = true;
      return null;
    }
    throw new Error(`unexpected command ${command}`);
  });
}

describe("SettingsTab", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "#settings-scan");
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    vi.mocked(invoke).mockReset();
    priceNoticeBackend(null);
  });

  it("价格整理提示没关时，目录里的「模型价格」挂「已整理」，关掉后回到「已加载」", async () => {
    priceNoticeBackend(PRICE_NOTICE);
    render(<SettingsTab {...props} />);

    // Seen from the default section, before the price section is opened.
    const pricing = await screen.findByRole("button", { name: /^模型价格.*已整理$/ }, { timeout: 5000 });
    const badge = pricing.querySelector(".settings-nav-status");
    expect(badge).toHaveTextContent("已整理");
    expect(badge).toHaveClass("settings-nav-status-attention");

    fireEvent.click(pricing);
    fireEvent.click(await screen.findByRole("button", { name: "知道了，不再提示" }, { timeout: 5000 }));

    expect(await screen.findByRole("button", { name: /^模型价格.*已加载$/ }, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^模型价格.*已整理$/ })).not.toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("dismiss_price_migration_notice", { id: PRICE_NOTICE.id });
  });

  it("没有价格整理提示时「模型价格」照旧是「已加载」", async () => {
    render(<SettingsTab {...props} />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("get_price_migration_notice"));
    expect(screen.getByRole("button", { name: /^模型价格.*已加载$/ })).toBeInTheDocument();
  });

  it("提示开着、价格又有未保存的修改时，先报「未保存」", async () => {
    priceNoticeBackend(PRICE_NOTICE);
    render(<SettingsTab {...props} pricing={{ ...props.pricing, pricesDirty: true }} />);
    fireEvent.click(screen.getByRole("button", { name: /^模型价格/ }));
    expect(await screen.findByRole("region", { name: "已整理你保存过的价格" })).toBeVisible();
    expect(screen.getByRole("button", { name: /^模型价格.*未保存$/ })).toBeInTheDocument();
  });

  it("扫描目录忽略未实现的旧自动启动标记，仍反映最小化偏好", () => {
    const legacyProps = {
      ...props,
      scanStartup: {
        ...props.scanStartup,
        appSettings: { ...props.scanStartup.appSettings, autostart_enabled: true },
      },
    };
    const { rerender } = render(<SettingsTab {...legacyProps} />);
    expect(screen.getByRole("button", {
      name: /^扫描与启动.*默认$/,
    })).toBeVisible();
    rerender(<SettingsTab {...legacyProps} scanStartup={{
      ...legacyProps.scanStartup,
      appSettings: { ...legacyProps.scanStartup.appSettings, start_minimized: true },
    }} />);
    expect(screen.getByRole("button", {
      name: /^扫描与启动.*已配置$/,
    })).toBeVisible();
  });

  it("一次只显示一个分区，并保留稳定的哈希深链", () => {
    render(<SettingsTab {...props} />);
    expect(screen.getByText("扫描内容")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /桌面壁纸/ }));
    expect(window.location.hash).toBe("#settings-wallpaper");
    expect(screen.getByText("壁纸内容")).toBeVisible();
    expect(screen.getByText("扫描内容")).not.toBeVisible();
    window.history.replaceState(null, "", "#settings-cloud");
    fireEvent.popState(window);
    expect(screen.getByText("账户内容")).toBeVisible();
  });

  it("响应应用传入的设置锚点", () => {
    const onSettingsAnchorHandled = vi.fn();
    render(
      <SettingsTab
        {...props}
        settingsAnchor="settings-quota"
        onSettingsAnchorHandled={onSettingsAnchorHandled}
      />,
    );
    expect(screen.getByText("额度内容")).toBeVisible();
    expect(window.location.hash).toBe("#settings-quota");
    expect(document.activeElement).toBe(screen.getByText("额度内容"));
    return waitFor(() =>
      expect(onSettingsAnchorHandled).toHaveBeenCalledTimes(1),
    );
  });

  it("切换长分区后重置应用内容滚动位置", () => {
    const content = document.createElement("div");
    content.className = "app-content";
    document.body.append(content);
    const view = render(<SettingsTab {...props} />, { container: content });
    content.scrollTop = 480;
    fireEvent.click(screen.getByRole("button", { name: /桌面壁纸/ }));
    expect(content.scrollTop).toBe(0);
    view.unmount();
    content.remove();
  });

  it("目录搜索提供无结果与清除入口", () => {
    render(<SettingsTab {...props} />);
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索设置" }), {
      target: { value: "不存在的项目" },
    });
    expect(
      screen.getByText("目录里没有匹配项，右侧仍是全部设置。"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "清除搜索" }));
    expect(
      screen.getByRole("button", { name: /扫描与启动/ }),
    ).toBeInTheDocument();
  });
});
