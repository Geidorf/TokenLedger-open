import {
  Filter,
  Hourglass,
  LayoutGrid,
  MousePointerClick,
  Palette,
  Rocket,
  Timer,
} from "lucide-react";
import type { AppSettings, BusyState, QuotaProviderEnvelope } from "../../types";
import { providerDisplayName } from "../../utils/quotaOverview";
import {
  TRAY_HOVER_DELAY_CHOICES,
  WIDGET_LAYOUTS,
  WIDGET_RANGES,
  WIDGET_THEMES,
  parseTrayHoverDelay,
  widgetConfigFromSettings,
  widgetSettingKeys,
  type WidgetSurface,
} from "../../utils/widgetConfig";
import { WidgetPreview } from "../widget/WidgetPreview";
import {
  SettingsCard,
  SettingsGroup,
  SettingsRow,
  SettingsSection,
  SettingsToggleRow,
} from "./SettingsPrimitives";

/**
 * 桌面挂件设置（T10.123 建分区，T10.124 补内容配置）。
 *
 * 桌面端有两块挂件，此前它们没有自己的分区：三个开关散在「扫描与启动」的两张卡片里，
 * 设置目录里也没有对应条目（更边缘的壁纸反而有独立分区）。更糟的是「启动时显示桌面挂件」
 * 这条开关实际打开的是**托盘挂件**（`widget_open_at_startup` → `widget_window::show_pinned`），
 * 名字指向了另一块挂件。这里把两块挂件各自成卡、各自说清楚，命名与托盘菜单保持一致：
 *
 * - **托盘挂件**：从托盘 / 菜单栏图标旁弹出，指针移开即收起，单击钉住。
 * - **桌面小组件**：常驻桌面层（壁纸之上、其他窗口之下），记住拖动后的位置。
 *
 * 两块挂件的**内容配置各存一份**（板式 / 主题 / 默认范围 / 额度来源），对齐 Android 的
 * 每实例 `WidgetConfig`：「扫一眼就走」和「一直摆在那儿」要看的东西本来就不一样。
 */

type QuotaProviderOption = Pick<
  QuotaProviderEnvelope,
  "providerId" | "displayName"
> &
  Partial<Pick<QuotaProviderEnvelope, "scope">>;

export interface WidgetSectionProps {
  appSettings: AppSettings;
  busy: BusyState;
  /** 可钉住的额度来源；空数组时「只看某个来源」这一项只剩「全部来源」。 */
  quotaProviders: QuotaProviderOption[];
  onSettingChange: <K extends keyof AppSettings>(
    key: K,
    value: AppSettings[K],
  ) => void;
}

interface ContentGroupProps extends WidgetSectionProps {
  surface: WidgetSurface;
  /** 用在 aria-label 前缀上：一页里有两组同名控件，读屏必须能区分。 */
  surfaceName: string;
}

/**
 * 悬停停留时长。托盘图标很窄，去点旁边的图标或滑向右下角都会扫过它，
 * 旧实现在 `Enter` 事件上直接弹出，于是"路过"被当成"想看"。
 */
function TrayHoverDelayRow(props: WidgetSectionProps) {
  const { appSettings, busy } = props;
  const delay = parseTrayHoverDelay(appSettings.tray_hover_delay_ms);
  const choice = TRAY_HOVER_DELAY_CHOICES.find((item) => item.ms === delay);
  return (
    <SettingsRow
      label="停留多久才弹出"
      hint={choice?.hint ?? `停留 ${delay} 毫秒后弹出。`}
      icon={Hourglass}
    >
      <select
        className="settings-select"
        aria-label="托盘挂件停留多久才弹出"
        value={String(delay)}
        disabled={busy.settings || !appSettings.tray_hover_widget_enabled}
        onChange={(event) =>
          props.onSettingChange("tray_hover_delay_ms", Number(event.target.value))
        }
      >
        {TRAY_HOVER_DELAY_CHOICES.map((item) => (
          <option key={item.ms} value={item.ms}>
            {item.label}
          </option>
        ))}
        {!choice && <option value={delay}>{`自定义（${delay} 毫秒）`}</option>}
      </select>
    </SettingsRow>
  );
}

function WidgetContentGroup(props: ContentGroupProps) {
  const { appSettings, busy, quotaProviders, surface, surfaceName } = props;
  const keys = widgetSettingKeys(surface);
  const config = widgetConfigFromSettings(appSettings, surface);
  const layout = WIDGET_LAYOUTS.find((item) => item.id === config.layout);
  // 钉住的来源可能已被删除或掉线。此时下拉框里必须留一条对应的选项，
  // 否则控件会显示空白，看上去像「没选来源」，而挂件其实还钉着它。
  const pinnedMissing =
    config.providerId !== null &&
    !quotaProviders.some((item) => item.providerId === config.providerId);
  return (
    <SettingsGroup>
      <SettingsRow
        label="板式"
        hint={layout?.description}
        icon={LayoutGrid}
      >
        <select
          className="settings-select"
          aria-label={`${surfaceName}板式`}
          value={config.layout}
          disabled={busy.settings}
          onChange={(event) =>
            props.onSettingChange(keys.layout, event.target.value)
          }
        >
          {WIDGET_LAYOUTS.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </select>
      </SettingsRow>
      <SettingsRow label="主题" icon={Palette}>
        <select
          className="settings-select"
          aria-label={`${surfaceName}主题`}
          value={config.theme}
          disabled={busy.settings}
          onChange={(event) =>
            props.onSettingChange(keys.theme, event.target.value)
          }
        >
          {WIDGET_THEMES.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </select>
      </SettingsRow>
      <SettingsRow
        label="默认范围"
        hint="挂件顶部的按钮只临时生效，关掉后回到这里"
        icon={Timer}
      >
        <select
          className="settings-select"
          aria-label={`${surfaceName}默认范围`}
          value={config.range}
          disabled={busy.settings}
          onChange={(event) =>
            props.onSettingChange(keys.range, event.target.value)
          }
        >
          {WIDGET_RANGES.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </select>
      </SettingsRow>
      <SettingsRow
        label="额度来源"
        hint={
          pinnedMissing
            ? "这个来源当前读不到；挂件会直说，不会改显示别人的额度"
            : "默认自动挑最吃紧的一条"
        }
        icon={Filter}
      >
        <select
          className="settings-select"
          aria-label={`${surfaceName}额度来源`}
          value={config.providerId ?? ""}
          disabled={busy.settings}
          onChange={(event) =>
            props.onSettingChange(keys.provider, event.target.value || null)
          }
        >
          <option value="">全部来源（自动挑最紧的）</option>
          {quotaProviders.map((item) => (
            <option key={item.providerId} value={item.providerId}>
              {providerDisplayName(item)}
            </option>
          ))}
          {pinnedMissing && (
            <option value={config.providerId ?? ""}>
              {config.providerId}（当前读不到）
            </option>
          )}
        </select>
      </SettingsRow>
    </SettingsGroup>
  );
}

export function WidgetSection(props: WidgetSectionProps) {
  const { appSettings, busy } = props;
  return (
    <SettingsSection id="widget" title="桌面挂件">
      <SettingsCard
        title="托盘挂件"
        description="从托盘图标旁弹出的小窗，不占任务栏、不抢焦点。"
      >
        <SettingsGroup>
          <SettingsToggleRow
            label="指向托盘图标时弹出"
            hint="移开后自动收起；单击可钉住不收。"
            icon={MousePointerClick}
            checked={appSettings.tray_hover_widget_enabled}
            disabled={busy.settings}
            busy={busy.settings}
            onChange={(checked) =>
              props.onSettingChange("tray_hover_widget_enabled", checked)
            }
          />
          <TrayHoverDelayRow {...props} />
          <SettingsToggleRow
            label="启动时直接钉住托盘挂件"
            hint="开机后直接显示，不必先点托盘图标。"
            icon={Rocket}
            checked={appSettings.widget_open_at_startup}
            disabled={busy.settings}
            busy={busy.settings}
            onChange={(checked) =>
              props.onSettingChange("widget_open_at_startup", checked)
            }
          />
        </SettingsGroup>
        <WidgetContentGroup {...props} surface="popover" surfaceName="托盘挂件" />
        {/* 静态预览（T10.192，P12）：复用挂件的同一张卡片，按这块挂件当前的板式、主题与默认范围画示例数据。 */}
        <WidgetPreview surface="popover" config={widgetConfigFromSettings(appSettings, "popover")} />
      </SettingsCard>
      <SettingsCard
        title="桌面小组件"
        description="常驻桌面的一块卡片，可拖动，位置会记住。内容与托盘挂件各配各的。"
      >
        <SettingsGroup>
          <SettingsToggleRow
            label="在桌面上常驻小组件"
            hint="与小组件悬停工具条里的“从桌面移除”同源；不影响托盘挂件。"
            icon={LayoutGrid}
            checked={appSettings.desktop_widget_enabled}
            disabled={busy.settings}
            busy={busy.settings}
            onChange={(checked) =>
              props.onSettingChange("desktop_widget_enabled", checked)
            }
          />
        </SettingsGroup>
        <WidgetContentGroup {...props} surface="desktop" surfaceName="桌面小组件" />
        <WidgetPreview surface="desktop" config={widgetConfigFromSettings(appSettings, "desktop")} />
      </SettingsCard>
    </SettingsSection>
  );
}

export default WidgetSection;
