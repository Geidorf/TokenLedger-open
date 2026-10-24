import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ScanStartupSection, scanFrequencyHint } from "./ScanStartupSection";

const props = {
  appSettings: { scan_interval_secs: 900 },
  busy: { settings: false },
  onSettingChange: () => undefined,
  onSettingChangeDebounced: () => undefined,
  onFlushSettingChange: () => undefined,
} as unknown as React.ComponentProps<typeof ScanStartupSection>;

describe("ScanStartupSection", () => {
  it.each([false, true])("旧自动启动配置为 %s 时也明确说明不可用，不提交无效操作", (enabled) => {
    const onSettingChange = vi.fn();
    render(<ScanStartupSection {...props}
      appSettings={{ ...props.appSettings, autostart_enabled: enabled }}
      onSettingChange={onSettingChange}
    />);
    expect(screen.queryByRole("switch", { name: "开机自动启动" })).not.toBeInTheDocument();
    expect(screen.getByText("应用内暂不支持")).toBeVisible();
    fireEvent.click(screen.getByText("开机自动启动"));
    expect(onSettingChange).not.toHaveBeenCalled();
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
