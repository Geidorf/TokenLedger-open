import { useEffect, useState } from "react";
import { Coins, FolderSearch, Power, Rocket, Timer } from "lucide-react";
import type { AppSettings, BusyState } from "../../types";
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

/** 每行一个目录；去掉首尾空白、空行与重复项。 */
export function parseExtraDirs(text: string): string[] {
  const dirs: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const dir = line.trim();
    if (dir && !dirs.includes(dir)) dirs.push(dir);
  }
  return dirs;
}

function CodexExtraDirsRow(props: ScanStartupSectionProps) {
  const saved = props.appSettings.codex_extra_dirs ?? [];
  const savedText = saved.join("\n");
  const [draft, setDraft] = useState(savedText);
  useEffect(() => setDraft(savedText), [savedText]);
  const commit = () => {
    const next = parseExtraDirs(draft);
    if (next.join("\n") !== savedText) {
      props.onSettingChange("codex_extra_dirs", next);
    }
  };
  return (
    <SettingsRow
      label="额外的 Codex 日志目录"
      hint="已自动扫描默认目录与 Cindy 的 Codex 目录。其他把 Codex 装在别处的应用，在这里每行填一个 Codex 主目录或 sessions 目录，可写 ~ 或 %APPDATA%。"
      icon={FolderSearch}
      wideControl
    >
      <textarea
        className="settings-input settings-dir-list"
        rows={3}
        spellCheck={false}
        value={draft}
        placeholder={"%APPDATA%\\Example\\codex-home\n~/example/codex-home"}
        aria-label="额外的 Codex 日志目录"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        disabled={props.busy.settings}
      />
    </SettingsRow>
  );
}

export function ScanStartupSection(props: ScanStartupSectionProps) {
  const { appSettings, busy } = props;
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
          <CodexExtraDirsRow {...props} />
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
      <SettingsCard title="菜单栏">
        <SettingsGroup>
          <SettingsToggleRow
            label="菜单栏显示今日预估费用（仅 macOS）"
            hint="在菜单栏图标旁显示今天的预估费用；Windows 在悬停提示中显示。"
            icon={Coins}
            checked={appSettings.tray_text_enabled}
            disabled={busy.settings}
            busy={busy.settings}
            onChange={(checked) =>
              props.onSettingChange("tray_text_enabled", checked)
            }
          />
        </SettingsGroup>
      </SettingsCard>
    </SettingsSection>
  );
}

export default ScanStartupSection;
