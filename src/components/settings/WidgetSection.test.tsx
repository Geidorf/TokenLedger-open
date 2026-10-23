import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WidgetSection } from "./WidgetSection";

const PROVIDERS = [
  {
    providerId: "anthropic-claude-consumer",
    displayName: "Anthropic Claude",
    scope: "consumer-subscription",
  },
  {
    providerId: "openai-codex-local",
    displayName: "OpenAI Codex",
    scope: "consumer-subscription",
  },
];

function renderSection(
  overrides: Record<string, unknown> = {},
  onSettingChange = vi.fn(),
  extra: Record<string, unknown> = {},
) {
  const props = {
    appSettings: {
      tray_hover_widget_enabled: true,
      tray_hover_delay_ms: 450,
      widget_open_at_startup: false,
      desktop_widget_enabled: false,
      widget_popover_layout: "usage",
      widget_popover_theme: "system",
      widget_popover_range: "today",
      widget_popover_provider: null,
      widget_desktop_layout: "usage",
      widget_desktop_theme: "system",
      widget_desktop_range: "today",
      widget_desktop_provider: null,
      ...overrides,
    },
    busy: { settings: false },
    quotaProviders: PROVIDERS,
    onSettingChange,
    ...extra,
  } as unknown as React.ComponentProps<typeof WidgetSection>;
  render(<WidgetSection {...props} />);
  return onSettingChange;
}

describe("WidgetSection", () => {
  it("两块挂件各自成卡，标题就说清是哪一块", () => {
    renderSection();
    expect(
      screen.getByRole("heading", { name: "桌面挂件" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "托盘挂件" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "桌面小组件" }),
    ).toBeInTheDocument();
    // 卡片描述必须说明这两块东西分别长在哪，光靠标题分不清。
    expect(screen.getByText(/图标旁弹出的小窗/)).toBeInTheDocument();
    expect(screen.getByText(/常驻桌面的一块卡片/)).toBeInTheDocument();
  });

  it("启动开关归到托盘挂件名下，不再叫「启动时显示桌面挂件」", () => {
    // widget_open_at_startup 走的是 widget_window::show_pinned，开的是托盘挂件；
    // 旧文案把它挂在「桌面」名下，等于指向了另一块挂件。
    renderSection();
    expect(screen.getByText("启动时直接钉住托盘挂件")).toBeInTheDocument();
    expect(screen.queryByText("启动时显示桌面挂件")).not.toBeInTheDocument();
  });

  it("三个开关都回写各自的设置键", () => {
    const onSettingChange = renderSection();
    fireEvent.click(screen.getByRole("switch", { name: "指向托盘图标时弹出" }));
    fireEvent.click(
      screen.getByRole("switch", { name: "启动时直接钉住托盘挂件" }),
    );
    fireEvent.click(screen.getByRole("switch", { name: "在桌面上常驻小组件" }));
    expect(onSettingChange.mock.calls).toEqual([
      ["tray_hover_widget_enabled", false],
      ["widget_open_at_startup", true],
      ["desktop_widget_enabled", true],
    ]);
  });

  it("保存中时开关禁用并暴露 busy 语义", () => {
    renderSection({}, vi.fn(), { busy: { settings: true } });
    const toggle = screen.getByRole("switch", {
      name: "在桌面上常驻小组件，保存中",
    });
    expect(toggle).toBeDisabled();
    expect(toggle).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("combobox", { name: "托盘挂件板式" })).toBeDisabled();
  });

  it("两块挂件各有一整组内容配置，键互不串台", () => {
    // 「扫一眼就走」和「一直摆在那儿」要看的东西不一样，所以配置是每块一份，
    // 对齐 Android 的每实例 WidgetConfig。
    const onSettingChange = renderSection();
    fireEvent.change(screen.getByRole("combobox", { name: "托盘挂件板式" }), {
      target: { value: "compact" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "桌面小组件板式" }), {
      target: { value: "quota" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "托盘挂件主题" }), {
      target: { value: "light" },
    });
    fireEvent.change(
      screen.getByRole("combobox", { name: "桌面小组件默认范围" }),
      { target: { value: "month" } },
    );
    expect(onSettingChange.mock.calls).toEqual([
      ["widget_popover_layout", "compact"],
      ["widget_desktop_layout", "quota"],
      ["widget_popover_theme", "light"],
      ["widget_desktop_range", "month"],
    ]);
  });

  it("板式下拉的提示跟着当前选择走，四种板式都能选到", () => {
    renderSection({ widget_popover_layout: "quota" });
    const layout = screen.getByRole("combobox", {
      name: "托盘挂件板式",
    }) as HTMLSelectElement;
    expect(layout.value).toBe("quota");
    expect(
      Array.from(layout.options).map((option) => option.value),
    ).toEqual(["usage", "combo", "quota", "compact", "routing"]);
    expect(screen.getByText(/按吃紧程度排列/)).toBeInTheDocument();
  });

  it("额度来源用与看板一致的短名，空值表示自动挑最紧的", () => {
    const onSettingChange = renderSection();
    const provider = screen.getByRole("combobox", {
      name: "托盘挂件额度来源",
    }) as HTMLSelectElement;
    expect(provider.value).toBe("");
    expect(Array.from(provider.options).map((option) => option.text)).toEqual([
      "全部来源（自动挑最紧的）",
      "Claude",
      "Codex",
    ]);
    fireEvent.change(provider, {
      target: { value: "anthropic-claude-consumer" },
    });
    fireEvent.change(provider, { target: { value: "" } });
    expect(onSettingChange.mock.calls).toEqual([
      ["widget_popover_provider", "anthropic-claude-consumer"],
      ["widget_popover_provider", null],
    ]);
  });

  it("悬停停留时长可调，关掉悬停后这一项跟着禁用", () => {
    // 托盘图标只有十几像素宽，去点旁边的图标也会扫过它；
    // 没有停留判定就变成「路过即弹出」。
    const onSettingChange = renderSection();
    const delay = screen.getByRole("combobox", {
      name: "托盘挂件停留多久才弹出",
    }) as HTMLSelectElement;
    expect(delay.value).toBe("450");
    expect(Array.from(delay.options).map((option) => option.value)).toEqual([
      "0",
      "250",
      "450",
      "900",
    ]);
    fireEvent.change(delay, { target: { value: "900" } });
    expect(onSettingChange.mock.calls).toEqual([["tray_hover_delay_ms", 900]]);

    cleanup();
    renderSection({ tray_hover_widget_enabled: false });
    expect(
      screen.getByRole("combobox", { name: "托盘挂件停留多久才弹出" }),
    ).toBeDisabled();
  });

  it("手改出的停留时长照常显示，不让下拉框变空白", () => {
    renderSection({ tray_hover_delay_ms: 600 });
    const delay = screen.getByRole("combobox", {
      name: "托盘挂件停留多久才弹出",
    }) as HTMLSelectElement;
    expect(delay.value).toBe("600");
    expect(screen.getByText("自定义（600 毫秒）")).toBeInTheDocument();
  });

  it("每张卡带一块静态预览：同一张卡片、示例数据，按这块挂件的板式、主题与默认范围画（T10.192 P12）", () => {
    renderSection({
      widget_popover_layout: "combo",
      widget_popover_theme: "light",
      widget_desktop_layout: "quota",
      widget_desktop_theme: "dark",
      widget_desktop_range: "week",
    });
    expect(
      screen.getAllByText(/^预览 · 示例数据/).map((node) => node.textContent),
    ).toEqual([
      "预览 · 示例数据（额度与用量 · 浅色 · 今日 · 364×198）",
      "预览 · 示例数据（额度总览 · 深色 · 本周 · 364×272）",
    ]);
    const roots = document.querySelectorAll(".widget-root.is-preview");
    expect(roots).toHaveLength(2);
    expect(roots[0]).toHaveAttribute("data-mode", "popover");
    expect(roots[0]).toHaveAttribute("data-layout", "combo");
    expect(roots[0]).toHaveAttribute("data-card-theme", "light");
    expect(roots[0]).toHaveStyle({ width: "364px", height: "198px" });
    expect(roots[0].querySelector(".wl-combo-num")).toHaveTextContent("1.39M");
    expect(roots[1]).toHaveAttribute("data-mode", "desktop");
    expect(roots[1]).toHaveAttribute("data-layout", "quota");
    expect(roots[1]).toHaveAttribute("data-card-theme", "dark");
    expect(roots[1].querySelectorAll(".wl-ring")).toHaveLength(6);
    // 托盘挂件的预览带（静态的）顶栏，桌面小组件平时没有按钮，预览也没有。
    expect(roots[0].querySelector(".wl-bar")).not.toBeNull();
    expect(roots[1].querySelector(".wl-bar, .wl-toolbar")).toBeNull();
  });

  it("预览不可聚焦、不可点，读屏只读图注", () => {
    renderSection();
    const frames = document.querySelectorAll(".wl-preview-frame");
    expect(frames).toHaveLength(2);
    for (const frame of frames) {
      expect(frame).toHaveAttribute("aria-hidden", "true");
      expect(frame).toHaveAttribute("inert");
      expect(
        frame.querySelectorAll("button, a, input, select, [tabindex]"),
      ).toHaveLength(0);
    }
    expect(screen.queryByRole("button", { name: "刷新扫描" })).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "统计范围" })).not.toBeInTheDocument();
  });

  it("钉住的来源已经掉线时留一条对应选项，不装作没钉过", () => {
    // 下拉框没有匹配项会显示空白，看上去像「全部来源」，而挂件其实还钉着它。
    renderSection({ widget_desktop_provider: "google-antigravity-consumer" });
    const provider = screen.getByRole("combobox", {
      name: "桌面小组件额度来源",
    }) as HTMLSelectElement;
    expect(provider.value).toBe("google-antigravity-consumer");
    expect(screen.getByText(/这个来源当前读不到/)).toBeInTheDocument();
  });
});
