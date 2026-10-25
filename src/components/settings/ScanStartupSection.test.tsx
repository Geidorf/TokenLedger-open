import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ScanStartupSection, parseExtraDirs, scanFrequencyHint } from "./ScanStartupSection";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const invokeMock = vi.mocked(invoke);

function autostartStatus(
  overrides: Partial<{
    supported: boolean;
    enabled: boolean | null;
    error: string | null;
  }> = {},
) {
  return {
    supported: true,
    enabled: false,
    error: null,
    ...overrides,
  };
}

const props = {
  appSettings: { scan_interval_secs: 900 },
  busy: { settings: false },
  onSettingChange: () => undefined,
  onSettingChangeDebounced: () => undefined,
  onFlushSettingChange: () => undefined,
} as unknown as React.ComponentProps<typeof ScanStartupSection>;

describe("ScanStartupSection", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "get_autostart_status") {
        return autostartStatus({ supported: false, enabled: null });
      }
      throw new Error("unknown command");
    });
  });

  it("开关以系统真实登记状态为准，不采用旧偏好", async () => {
    invokeMock.mockResolvedValue(autostartStatus({ enabled: false }));
    const onSettingChange = vi.fn();
    render(<ScanStartupSection {...props}
      appSettings={{ ...props.appSettings, autostart_enabled: true }}
      onSettingChange={onSettingChange}
    />);
    const toggle = await screen.findByRole("switch", { name: "开机自动启动" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(invokeMock).toHaveBeenCalledWith("get_autostart_status");
    expect(invokeMock).not.toHaveBeenCalledWith("autostart_supported");

    fireEvent.click(toggle);
    expect(onSettingChange).toHaveBeenCalledExactlyOnceWith("autostart_enabled", true);
  });

  it("旧偏好相同时仍允许用户显式提交启用", async () => {
    invokeMock.mockResolvedValue(autostartStatus({ enabled: false }));
    const onSettingChange = vi.fn();
    render(<ScanStartupSection {...props}
      appSettings={{ ...props.appSettings, autostart_enabled: false }}
      onSettingChange={onSettingChange}
    />);
    fireEvent.click(await screen.findByRole("switch", { name: "开机自动启动" }));
    expect(onSettingChange).toHaveBeenCalledExactlyOnceWith("autostart_enabled", true);
  });

  it("不支持时显示只读说明，不把未知状态当作关闭开关", async () => {
    invokeMock.mockResolvedValue(autostartStatus({ supported: false, enabled: null }));
    render(<ScanStartupSection {...props} />);
    expect(await screen.findByText("应用内暂不支持")).toBeVisible();
    expect(screen.queryByRole("switch", { name: "开机自动启动" })).not.toBeInTheDocument();
  });

  it("读取失败时显示不可用与错误，可重试恢复真实状态", async () => {
    invokeMock
      .mockRejectedValueOnce(new Error("registry unavailable"))
      .mockResolvedValueOnce(autostartStatus({ enabled: true }));
    render(<ScanStartupSection {...props} />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "读取系统登录自启状态失败：Error: registry unavailable",
    );
    expect(screen.queryByRole("switch", { name: "开机自动启动" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "重试读取系统登录自启状态" }));
    const toggle = await screen.findByRole("switch", { name: "开机自动启动" });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(invokeMock.mock.calls.filter(([command]) => command === "get_autostart_status")).toHaveLength(2);
  });

  it("响应无效或带错误时均显示不可用，并把错误呈现为警报", async () => {
    invokeMock
      .mockResolvedValueOnce({ supported: true, enabled: "yes", error: null })
      .mockResolvedValueOnce(autostartStatus({
        supported: true,
        enabled: null,
        error: "启动项状态无法读取",
      }));
    const { unmount } = render(<ScanStartupSection {...props} />);
    const firstAlert = await screen.findByRole("alert");
    expect(firstAlert).toHaveTextContent("系统返回了无法识别的登录自启状态。");
    expect(firstAlert).not.toHaveTextContent("关闭");

    fireEvent.click(screen.getByRole("button", { name: "重试读取系统登录自启状态" }));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("启动项状态无法读取");
    });
    unmount();
  });

  it("位置失效时仅在显式重新启用后登记，并等待回读确认", async () => {
    const stale = autostartStatus({
      enabled: null,
      error: "登录启动项指向其他程序位置，请按当前位置重新启用。",
    });
    invokeMock.mockResolvedValue(stale);
    let finishSave: ((value: boolean) => void) | undefined;
    const onSettingChange = vi.fn(() => new Promise<boolean>((resolve) => {
      finishSave = resolve;
    }));
    render(<ScanStartupSection {...props} onSettingChange={onSettingChange} />);

    const repair = await screen.findByRole("button", { name: "按当前位置重新启用" });
    expect(onSettingChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("switch", { name: "开机自动启动" })).not.toBeInTheDocument();
    fireEvent.click(repair);
    fireEvent.click(repair);
    expect(onSettingChange).toHaveBeenCalledExactlyOnceWith("autostart_enabled", true);
    expect(repair).toBeDisabled();
    expect(screen.getByRole("button", { name: "重试读取系统登录自启状态" })).toBeDisabled();

    fireEvent.focus(window);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    invokeMock.mockResolvedValue(autostartStatus({ enabled: true }));
    finishSave?.(true);
    const toggle = await screen.findByRole("switch", { name: "开机自动启动" });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(toggle).toBeEnabled();
  });

  it("重新启用失败后保留未知状态并允许再次操作", async () => {
    invokeMock.mockResolvedValue(autostartStatus({
      enabled: null,
      error: "登录启动项指向其他程序位置，请按当前位置重新启用。",
    }));
    const onSettingChange = vi.fn(async () => {
      throw new Error("registration failed");
    });
    render(<ScanStartupSection {...props} onSettingChange={onSettingChange} />);

    fireEvent.click(await screen.findByRole("button", { name: "按当前位置重新启用" }));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledTimes(2);
      expect(screen.getByRole("button", { name: "按当前位置重新启用" })).toBeEnabled();
    });
    expect(onSettingChange).toHaveBeenCalledExactlyOnceWith("autostart_enabled", true);
    expect(screen.getByRole("alert")).toHaveTextContent("登录启动项指向其他程序位置");
    expect(screen.queryByRole("switch", { name: "开机自动启动" })).not.toBeInTheDocument();
  });

  it("系统操作忙碌期间禁用开关，结束后重新读取实际状态", async () => {
    let enabled = false;
    invokeMock.mockImplementation(async () => autostartStatus({ enabled }));
    let finishSave: ((value: boolean) => void) | undefined;
    const onSettingChange = vi.fn(() => new Promise<boolean>((resolve) => {
      enabled = true;
      finishSave = resolve;
    }));
    const { rerender } = render(
      <ScanStartupSection {...props} onSettingChange={onSettingChange} />,
    );
    fireEvent.click(await screen.findByRole("switch", { name: "开机自动启动" }));
    expect(onSettingChange).toHaveBeenCalledWith("autostart_enabled", true);
    expect(screen.getByRole("switch", { name: /开机自动启动.*保存中/ })).toBeDisabled();
    expect(invokeMock.mock.calls.filter(([command]) => command === "get_autostart_status")).toHaveLength(1);

    finishSave?.(true);
    await waitFor(() => {
      expect(screen.getByRole("switch", { name: "开机自动启动" })).toHaveAttribute("aria-checked", "true");
    });
    expect(invokeMock.mock.calls.filter(([command]) => command === "get_autostart_status")).toHaveLength(2);
    rerender(
      <ScanStartupSection
        {...props}
        busy={{ ...props.busy, settings: true }}
        onSettingChange={onSettingChange}
      />,
    );
    expect(screen.getByRole("switch", { name: /开机自动启动.*保存中/ })).toBeDisabled();
  });

  it("void 回调依赖 busy 结束兜底重读，不在保存前读取旧状态", async () => {
    let enabled = false;
    invokeMock.mockImplementation(async () => autostartStatus({ enabled }));
    const onSettingChange = vi.fn(() => {
      enabled = true;
    });
    const { rerender } = render(
      <ScanStartupSection {...props} onSettingChange={onSettingChange} />,
    );
    fireEvent.click(await screen.findByRole("switch", { name: "开机自动启动" }));
    expect(onSettingChange).toHaveBeenCalledWith("autostart_enabled", true);
    expect(invokeMock.mock.calls.filter(([command]) => command === "get_autostart_status")).toHaveLength(1);
    expect(screen.getByRole("switch", { name: /开机自动启动.*保存中/ })).toBeDisabled();

    rerender(
      <ScanStartupSection
        {...props}
        busy={{ ...props.busy, settings: true }}
        onSettingChange={onSettingChange}
      />,
    );
    expect(invokeMock.mock.calls.filter(([command]) => command === "get_autostart_status")).toHaveLength(1);

    rerender(
      <ScanStartupSection {...props} onSettingChange={onSettingChange} />,
    );
    await waitFor(() => {
      expect(screen.getByRole("switch", { name: "开机自动启动" })).toHaveAttribute("aria-checked", "true");
    });
    expect(invokeMock.mock.calls.filter(([command]) => command === "get_autostart_status")).toHaveLength(2);
  });

  it("回调同步抛错或 Promise 拒绝时释放保存态并回读，不产生未处理拒绝", async () => {
    invokeMock.mockImplementation(async () => autostartStatus({ enabled: false }));
    const syncFailure = vi.fn(() => {
      throw new Error("sync failure");
    });
    const { rerender } = render(
      <ScanStartupSection {...props} onSettingChange={syncFailure} />,
    );
    fireEvent.click(await screen.findByRole("switch", { name: "开机自动启动" }));
    expect(syncFailure).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("switch", { name: "开机自动启动" })).toBeEnabled();
    expect(invokeMock.mock.calls.filter(([command]) => command === "get_autostart_status")).toHaveLength(2);

    const asyncFailure = vi.fn(async () => {
      throw new Error("async failure");
    });
    rerender(<ScanStartupSection {...props} onSettingChange={asyncFailure} />);
    fireEvent.click(screen.getByRole("switch", { name: "开机自动启动" }));
    expect(asyncFailure).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("switch", { name: "开机自动启动" })).toBeEnabled();
  });

  it("窗口重新聚焦时重读系统状态，旧请求不会覆盖新结果", async () => {
    let resolveFirst: ((value: unknown) => void) | undefined;
    let request = 0;
    invokeMock.mockImplementation(async () => {
      request += 1;
      if (request <= 2) {
        if (request === 1) return autostartStatus({ enabled: false });
        return new Promise((resolve) => {
          resolveFirst = resolve;
        });
      }
      return autostartStatus({ enabled: true });
    });
    render(<ScanStartupSection {...props} />);
    expect(await screen.findByRole("switch", { name: "开机自动启动" })).toHaveAttribute("aria-checked", "false");

    fireEvent.focus(window);
    await waitFor(() => {
      expect(invokeMock.mock.calls.filter(([command]) => command === "get_autostart_status")).toHaveLength(2);
    });
    fireEvent.focus(window);
    await waitFor(() => {
      expect(invokeMock.mock.calls.filter(([command]) => command === "get_autostart_status")).toHaveLength(3);
    });
    const toggle = await screen.findByRole("switch", { name: "开机自动启动" });
    expect(toggle).toHaveAttribute("aria-checked", "true");

    resolveFirst?.(autostartStatus({ enabled: false }));
    await waitFor(() => {
      expect(screen.getByRole("switch", { name: "开机自动启动" })).toHaveAttribute("aria-checked", "true");
    });
  });

  it("保留启动时最小化的可操作状态", () => {
    const onSettingChange = vi.fn();
    render(<ScanStartupSection {...props}
      appSettings={{ ...props.appSettings, start_minimized: false }}
      onSettingChange={onSettingChange}
    />);
    fireEvent.click(screen.getByRole("switch", { name: "启动时最小化到托盘" }));
    expect(onSettingChange).toHaveBeenCalledExactlyOnceWith("start_minimized", true);
  });

  it("额外 Codex 目录每行一个，失焦时去重保存", () => {
    const onSettingChange = vi.fn();
    render(<ScanStartupSection {...props}
      appSettings={{ ...props.appSettings, codex_extra_dirs: [] }}
      onSettingChange={onSettingChange}
    />);
    const input = screen.getByRole("textbox", { name: "额外的 Codex 日志目录" });
    fireEvent.change(input, {
      target: { value: " %APPDATA%\\Example\\codex-home \n\n~/codex\n~/codex" },
    });
    expect(onSettingChange).not.toHaveBeenCalled();
    fireEvent.blur(input);
    expect(onSettingChange).toHaveBeenCalledExactlyOnceWith("codex_extra_dirs", [
      "%APPDATA%\\Example\\codex-home",
      "~/codex",
    ]);
  });

  it("目录未变时失焦不重复保存", () => {
    const onSettingChange = vi.fn();
    render(<ScanStartupSection {...props}
      appSettings={{ ...props.appSettings, codex_extra_dirs: ["~/codex"] }}
      onSettingChange={onSettingChange}
    />);
    fireEvent.blur(screen.getByRole("textbox", { name: "额外的 Codex 日志目录" }));
    expect(onSettingChange).not.toHaveBeenCalled();
    expect(parseExtraDirs("a\r\n a \nb")).toEqual(["a", "b"]);
  });

  it("把秒数翻译成用户可读的扫描频率", () => {
    expect(scanFrequencyHint(900)).toContain("15 分钟");
    expect(scanFrequencyHint(7200)).toContain("2 小时");
  });

  it("把扫描、启动和菜单栏偏好分成卡片", () => {
    render(<ScanStartupSection {...props} />);
    expect(screen.getByRole("heading", { name: "扫描" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "启动" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "菜单栏与托盘" })).toBeInTheDocument();
  });

  it("不再承载两块挂件的开关：它们已迁到独立的「桌面挂件」分区", () => {
    render(<ScanStartupSection {...props} />);
    // 这一条同时守住命名回归：旧文案「启动时显示桌面挂件」打开的其实是托盘挂件。
    expect(screen.queryByText("启动时显示桌面挂件")).not.toBeInTheDocument();
    expect(screen.queryByText("指向托盘图标时弹出挂件")).not.toBeInTheDocument();
    expect(screen.queryByText("在桌面添加小组件")).not.toBeInTheDocument();
    expect(
      screen.getByText("在菜单栏 / 托盘上显示数字"),
    ).toBeInTheDocument();
  });

  it("菜单栏开关沿用「预估费用」叫法（T10.154 D64）", () => {
    render(<ScanStartupSection {...props} />);
    const metric = screen.getByRole("combobox", { name: "菜单栏与托盘显示哪个数字" }) as HTMLSelectElement;
    expect(Array.from(metric.options).map((option) => option.text)).toEqual(["今日预估费用", "最紧额度可用 %"]);
    expect(screen.getByText("今天的预估费用，与看板同一个数。")).toBeInTheDocument();
    expect(screen.queryByText(/成本/)).not.toBeInTheDocument();
  });

  it("数字开关关着时不能选显示哪个数字；选最紧额度时写清口径", () => {
    const onSettingChange = vi.fn();
    const { rerender } = render(<ScanStartupSection {...props} onSettingChange={onSettingChange} />);
    const metric = screen.getByRole("combobox", { name: "菜单栏与托盘显示哪个数字" }) as HTMLSelectElement;
    expect(metric).toBeDisabled();
    rerender(
      <ScanStartupSection
        {...props}
        appSettings={{ ...props.appSettings, tray_text_enabled: true, tray_text_metric: "quota" }}
        onSettingChange={onSettingChange}
      />,
    );
    expect(metric).toBeEnabled();
    expect(metric.value).toBe("quota");
    expect(screen.getByText(/可用比例最低的那条窗口/)).toBeInTheDocument();
    fireEvent.change(metric, { target: { value: "cost" } });
    expect(onSettingChange).toHaveBeenCalledWith("tray_text_metric", "cost");
  });
});
