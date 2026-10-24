import { Coins, Gauge, Power, Rocket, Timer } from "lucide-react";
import type { AppSettings, BusyState } from "../../types";
import { TRAY_TEXT_METRICS, parseTrayTextMetric } from "../../utils/widgetConfig";
import {
  SettingsCard,
  SettingsGroup,
  SettingsRow,
  SettingsSection,
  SettingsToggleRow,
} from "./SettingsPrimitives";

export interface ScanStartupSectionProps {
  appSettings: AppSettings;
  busy: BusyState;
  onSettingChange: <K extends keyof AppSettings>(
    key: K,
    value: AppSettings[K],
  ) => void;
  onSettingChangeDebounced: <K extends keyof AppSettings>(
    key: K,
    value: AppSettings[K],
  ) => void;
  onFlushSettingChange: () => void;
}

export function scanFrequencyHint(seconds: number): string {
  const minutes = seconds / 60;
  const frequency =
    minutes >= 60
      ? `约每 ${(minutes / 60).toFixed(minutes % 60 ? 1 : 0)} 小时`
      : `约每 ${Math.max(1, Math.round(minutes))} 分钟`;
  return `${frequency}扫描一次；最短 1 分钟。`;
}

export function ScanStartupSection(props: ScanStartupSectionProps) {
  const { appSettings, busy } = props;
  const metric = parseTrayTextMetric(appSettings.tray_text_metric);
  return (
    <SettingsSection id="scan" title="扫描与启动">
      <SettingsCard title="扫描">
        <SettingsGroup>
          <SettingsRow
            label="扫描本地日志（间隔：秒）"
            hint={scanFrequencyHint(appSettings.scan_interval_secs)}
            icon={Timer}
          >
            <input
              className="settings-number"
              type="number"
              min={60}
              value={appSettings.scan_interval_secs}
              aria-label="扫描间隔（秒）"
              onChange={(event) =>
                props.onSettingChangeDebounced(
                  "scan_interval_secs",
                  Number(event.target.value),
                )
              }
              onBlur={() => props.onFlushSettingChange()}
              disabled={busy.settings}
            />
          </SettingsRow>
        </SettingsGroup>
      </SettingsCard>
      <SettingsCard title="启动">
        <SettingsGroup>
          <SettingsRow label="开机自动启动" icon={Power}>
            <span className="settings-value">应用内暂不支持</span>
          </SettingsRow>
          <SettingsToggleRow
            label="启动时最小化到托盘"
            hint="开启后启动时不显示主窗口，可从菜单栏或托盘打开它。"
            icon={Rocket}
            checked={appSettings.start_minimized}
            disabled={busy.settings}
            busy={busy.settings}
            onChange={(checked) =>
              props.onSettingChange("start_minimized", checked)
            }
          />
        </SettingsGroup>
      </SettingsCard>
      {/* 两块挂件的开关已迁到独立的「桌面挂件」分区（T10.123）；这里只剩
          菜单栏文字，它是托盘图标本身的呈现，不是挂件窗口。 */}
      <SettingsCard title="菜单栏与托盘">
        <SettingsGroup>
          <SettingsToggleRow
            label="在菜单栏 / 托盘上显示数字"
            hint="macOS 写在菜单栏图标旁；Windows 把托盘图标换成带数字的徽章。悬停提示始终显示今日费用与最紧额度。"
            icon={Coins}
            checked={appSettings.tray_text_enabled}
            disabled={busy.settings}
            busy={busy.settings}
            onChange={(checked) =>
              props.onSettingChange("tray_text_enabled", checked)
            }
          />
          <SettingsRow
            label="显示哪个数字"
            hint={
              metric === "quota"
                ? "所有额度来源里可用比例最低的那条窗口，与额度看板同一口径；读不到额度时显示「—」。"
                : "今天的预估费用，与看板同一个数。"
            }
            icon={Gauge}
          >
            <select
              className="settings-select"
              aria-label="菜单栏与托盘显示哪个数字"
              value={metric}
              disabled={busy.settings || !appSettings.tray_text_enabled}
              onChange={(event) =>
                props.onSettingChange("tray_text_metric", event.target.value)
              }
            >
              {TRAY_TEXT_METRICS.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </SettingsRow>
        </SettingsGroup>
      </SettingsCard>
    </SettingsSection>
  );
}

export default ScanStartupSection;
