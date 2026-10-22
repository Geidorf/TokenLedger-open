import { useEffect, useRef, useState } from 'react';
import { EyeOff, FolderTree } from 'lucide-react';
import { ConfirmDialog } from '../ConfirmDialog';
import { useProjectDimension } from '../../hooks/useProjectDimension';
import { useHideProjectNames } from '../../utils/projectNamePrivacy';
import {
  PROJECT_DIMENSION_CARD_ID,
  consumeProjectDimensionFocus,
  projectFailureCopy,
} from '../../utils/projectDimension';
import { DisclosurePanel, SettingsCard, SettingsGroup, SettingsToggleRow } from './SettingsPrimitives';

/**
 * 「数据与帮助」里的本机项目维度开关。默认关闭；确认后才调用
 * `set_project_dimension`。关闭会让后端删掉本机项目行并截断 WAL（ADR-016）。
 */
export function ProjectDimensionCard() {
  const { status, loaded, busy, error, refresh, setEnabled, rebuild } = useProjectDimension();
  const { hidden, setHidden } = useHideProjectNames();
  const [pending, setPending] = useState<'enable' | 'disable' | null>(null);
  const [purgeNote, setPurgeNote] = useState('');
  const cardRef = useRef<HTMLDivElement>(null);
  const enabled = status?.enabled === true;

  useEffect(() => {
    if (!loaded || !consumeProjectDimensionFocus()) return;
    cardRef.current?.scrollIntoView({ block: 'center' });
    cardRef.current?.querySelector<HTMLButtonElement>('[role="switch"]')?.focus();
  }, [loaded]);

  const confirm = async () => {
    const turningOn = pending === 'enable';
    setPending(null);
    const next = await setEnabled(turningOn);
    if (!turningOn && next?.purge && !next.purge.walTruncated) {
      setPurgeNote('项目名已删除，数据库日志中的残留将在下次扫描时清除。');
    } else if (turningOn) {
      setPurgeNote('');
    } else if (next) {
      setPurgeNote('');
    }
  };

  const indexing = status?.state === 'indexing';
  const progress = status && status.backfill.total > 0
    ? `正在建立项目索引：已处理 ${status.backfill.done} / ${status.backfill.total} 个会话`
    : indexing
      ? '正在建立项目索引…'
      : null;

  return (
    <SettingsCard title="按项目统计">
      <div id={PROJECT_DIMENSION_CARD_ID} ref={cardRef} tabIndex={-1}>
        <SettingsGroup>
          <SettingsToggleRow
            label="按项目统计本机用量"
            hint="默认关闭。开启后只在这台电脑保存文件夹名，用于行为分析，不上传。"
            icon={FolderTree}
            checked={enabled}
            disabled={!loaded || busy}
            busy={busy}
            onChange={(next) => {
              if (!loaded || busy) return;
              setPending(next ? 'enable' : 'disable');
            }}
          />
          {status?.state === 'consent_required' && (
            <p className="settings-project-note" role="status">按项目统计的读取范围有更新，需要重新确认后才会继续采集。</p>
          )}
          {progress && <p className="settings-project-note" role="status">{progress}</p>}
          {status?.state === 'ready' && (
            <p className="settings-project-note" role="status">
              已开启。本机保存了 {status.namedProjects} 个项目名，覆盖 {status.indexedSessions} 个会话。
            </p>
          )}
          {status?.state === 'failed' && (
            <p className="settings-project-note" role="alert">
              {projectFailureCopy(status.lastFailure)}
              <button className="secondary-inline" type="button" onClick={() => void rebuild()} disabled={busy}>重试建立索引</button>
            </p>
          )}
          {purgeNote && <p className="settings-project-note" role="status">{purgeNote}</p>}
          {error && (
            <p className="settings-project-note" role="alert">
              {error}
              <button className="ghost-inline" type="button" onClick={() => void refresh()}>重试读取</button>
            </p>
          )}
          <SettingsToggleRow
            label="隐藏项目名"
            hint="只改本机显示，方便截图：项目名显示为“项目 1”这类代称，已保存的索引不变。"
            icon={EyeOff}
            checked={hidden}
            onChange={setHidden}
          />
          <DisclosurePanel title="了解详情：读取范围、数据边界与限制">
            <div className="settings-project-copy">
              <h4>会读取</h4>
              <ul>
                <li>各工具会话记录里的工作目录（如 Claude Code、Codex、OpenCode、Zcode），以及部分工具记录的仓库根目录（Grok、Hermes、OpenCode、Kilo）。</li>
                <li>部分工具会话元数据里的工作目录字段：Gemini CLI 的 <code>.project_root</code>（只取第一行，最多 4 KiB）；Kimi Code 与 Kimi Desktop 的 <code>state.json</code>、<code>session_index.jsonl</code>、<code>workspaces.json</code>；DeepSeek 桌面版每个会话的 <code>metadata.jsonl</code>。统计用量时并不打开这些文件。</li>
              </ul>
              <h4>不读取、不保存</h4>
              <ul>
                <li>只存一个文件夹名，不存完整路径、盘符或用户名；在主目录、磁盘根目录、临时目录或工具托管目录里的会话分别记为“主目录”“磁盘根目录”“临时目录”“托管会话”。</li>
                <li>不提取、不保存对话内容；不读代码文件、分支名、提交记录或远程仓库地址，也不查看 <code>.git</code>。</li>
                <li>项目名不离开这台电脑：不参与云同步，也不出现在 Android、分享海报、HTML 简报和 CSV 导出中。</li>
                <li>关闭即停止读取，并删除本机已保存的全部项目名；重新开启会重新建立索引。</li>
              </ul>
              <h4>已知限制</h4>
              <ul>
                <li>Antigravity、Trae、腾讯 Marvis 等工具的日志不记录工作目录，用量显示为“未归属”。</li>
                <li>子文件夹里启动的会话按子文件夹名归属；不同位置的同名文件夹合并为一个项目。</li>
                <li>工具已清理的旧日志无法再确定项目；一次会话只算入启动时所在的项目。</li>
                <li>为找到工作目录，会从日志开头逐行跳过对话内容（有行数与字节上限），跳过的内容不解析、不保存。本机数据库为增量扫描一直记录各日志文件的位置，与本开关无关，从不同步。</li>
              </ul>
            </div>
          </DisclosurePanel>
        </SettingsGroup>
      </div>
      {pending === 'enable' && (
        <ConfirmDialog
          title="开启按项目统计？"
          description="会读取各工具日志里的工作目录，以及 Gemini CLI 的 .project_root、Kimi Code 与 Kimi Desktop 的 state.json、session_index.jsonl、workspaces.json、DeepSeek 桌面版的 metadata.jsonl，只取工作目录字段。不保存完整路径，不提取、不保存对话内容，不读取分支、提交或远程地址，也不查看 .git。项目名只留在这台电脑，不参与云同步，也不会出现在 Android、分享海报、HTML 简报和 CSV 导出中。"
          confirmLabel="开启并建立索引"
          cancelLabel="取消"
          onCancel={() => setPending(null)}
          onConfirm={() => void confirm()}
        />
      )}
      {pending === 'disable' && (
        <ConfirmDialog
          title="关闭按项目统计？"
          description={`将停止读取工作目录，并删除这台电脑上已保存的 ${status?.namedProjects ?? 0} 个项目名（${status?.indexedSessions ?? 0} 条会话归属）。行为分析将不再显示项目。`}
          confirmLabel="关闭并删除"
          cancelLabel="保留开启"
          tone="danger"
          onCancel={() => setPending(null)}
          onConfirm={() => void confirm()}
        />
      )}
    </SettingsCard>
  );
}
