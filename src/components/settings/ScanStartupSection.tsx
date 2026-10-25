import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Coins, FolderSearch, Gauge, Power, Rocket, Timer } from "lucide-react";
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

/** 每行一个目录；去掉首尾空白、空行与重复项。 */
export function parseExtraDirs(text: string): string[] {
  const dirs: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const dir = line.trim();
    if (dir && !dirs.includes(dir)) dirs.push(dir);
  }
  return dirs;
}

interface AutostartStatus {
  supported: boolean;
  enabled: boolean | null;
  error: string | null;
}

type AutostartState =
  | { phase: "loading" }
  | { phase: "unsupported" }
  | { phase: "error"; message: string }
  | { phase: "ready"; enabled: boolean };

function parseAutostartStatus(value: unknown): AutostartStatus | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const status = value as Record<string, unknown>;
  if (
    typeof status.supported !== "boolean"
    || (status.enabled !== null && typeof status.enabled !== "boolean")
    || (status.error !== null && typeof status.error !== "string")
  ) {
    return null;
  }
  return {
    supported: status.supported,
    enabled: status.enabled,
    error: status.error,
  };
}

function useAutostartStatus(busy: boolean) {
  const [state, setState] = useState<AutostartState>({ phase: "loading" });
  const [pendingSnapshot, setPendingSnapshot] = useState(false);
  const requestIdRef = useRef(0);
  const mountedRef = useRef(false);
  const pendingSnapshotRef = useRef(false);
  const mutationBusyRef = useRef(false);
  const previousBusyRef = useRef(busy);
  const finishPendingRef = useRef<() => void>(() => undefined);

  const reload = useCallback(async (allowWhileBusy = false) => {
    if (!allowWhileBusy && mutationBusyRef.current) return;
    const requestId = ++requestIdRef.current;
    setState({ phase: "loading" });
    try {
      const value = await invoke<unknown>("get_autostart_status");
      if (requestId !== requestIdRef.current) return;
      const status = parseAutostartStatus(value);
      if (!status) {
        setState({
          phase: "error",
          message: "系统返回了无法识别的登录自启状态。",
        });
        return;
      }
      if (status.error) {
        setState({ phase: "error", message: status.error });
      } else if (!status.supported) {
        setState({ phase: "unsupported" });
      } else if (typeof status.enabled === "boolean") {
        setState({ phase: "ready", enabled: status.enabled });
      } else {
        setState({
          phase: "error",
          message: "系统没有返回登录自启的启用状态。",
        });
      }
    } catch (error) {
      if (requestId === requestIdRef.current) {
        setState({
          phase: "error",
          message: `读取系统登录自启状态失败：${String(error)}`,
        });
      }
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void reload();
    const refreshStatus = () => void reload();
    window.addEventListener("focus", refreshStatus);
    document.addEventListener("visibilitychange", refreshStatus);
    return () => {
      mountedRef.current = false;
      requestIdRef.current += 1;
      window.removeEventListener("focus", refreshStatus);
      document.removeEventListener("visibilitychange", refreshStatus);
    };
  }, [reload]);

  const finishPending = useCallback(() => {
    if (!pendingSnapshotRef.current) return;
    pendingSnapshotRef.current = false;
    mutationBusyRef.current = false;
    setPendingSnapshot(false);
    if (mountedRef.current) void reload();
  }, [reload]);
  finishPendingRef.current = finishPending;

  useEffect(() => {
    if (previousBusyRef.current && !busy) finishPendingRef.current();
    previousBusyRef.current = busy;
  }, [busy]);

  const requestChange = useCallback((
    enabled: boolean,
    onChange: (checked: boolean) => Promise<boolean> | void,
  ) => {
    if (pendingSnapshotRef.current) return;
    pendingSnapshotRef.current = true;
    mutationBusyRef.current = true;
    setPendingSnapshot(true);
    try {
      const result = onChange(enabled);
      if (result && typeof result.then === "function") {
        void result.then(finishPending, finishPending);
      }
    } catch {
      // 上层负责显示错误；这里统一释放并回读真实状态。
      finishPending();
    }
  }, [finishPending]);

  return { state, reload, requestChange, busy: pendingSnapshot };
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
  const metric = parseTrayTextMetric(appSettings.tray_text_metric);
  const autostart = useAutostartStatus(busy.settings);

  let autostartControl: React.ReactNode;
  if (autostart.state.phase === "loading") {
    autostartControl = (
      <SettingsRow label="开机自动启动" icon={Power} busy>
        <span className="settings-value" role="status" aria-live="polite">
          正在读取系统状态…
        </span>
      </SettingsRow>
    );
  } else if (autostart.state.phase === "unsupported") {
    autostartControl = (
      <SettingsRow label="开机自动启动" icon={Power}>
        <span className="settings-value">应用内暂不支持</span>
      </SettingsRow>
    );
  } else if (autostart.state.phase === "error") {
    autostartControl = (
      <SettingsRow
        label="开机自动启动"
        hint="无法确认系统登录自启状态；为避免误报，当前不显示为已关闭。"
        icon={Power}
      >
        <span className="settings-value" role="alert">
          {autostart.state.message}
        </span>
        <button
          className="secondary-inline"
          type="button"
          aria-label="重试读取系统登录自启状态"
          disabled={busy.settings}
          onClick={() => void autostart.reload()}
        >
          重试
        </button>
      </SettingsRow>
    );
  } else {
    autostartControl = (
      <SettingsToggleRow
        label="开机自动启动"
        hint="登录桌面后自动打开 TokenLedger；想让它只留在托盘，再打开下面的「启动时最小化到托盘」。"
        icon={Power}
        checked={autostart.state.enabled}
        disabled={busy.settings || autostart.busy}
        busy={busy.settings || autostart.busy}
        onChange={(checked) =>
          autostart.requestChange(checked, (enabled) =>
            props.onSettingChange("autostart_enabled", enabled),
          )
        }
      />
    );
  }

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
          {autostartControl}
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
