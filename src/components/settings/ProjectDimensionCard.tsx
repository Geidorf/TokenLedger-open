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
import { t, useLang } from '../../i18n';

/**
 * 「数据与帮助」里的本机项目维度开关。默认关闭；确认后才调用
 * `set_project_dimension`。关闭会让后端删掉本机项目行并截断 WAL（ADR-016）。
 */
export function ProjectDimensionCard() {
  useLang();
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
      setPurgeNote(t('project.purged'));
    } else if (turningOn) {
      setPurgeNote('');
    } else if (next) {
      setPurgeNote('');
    }
  };

  const indexing = status?.state === 'indexing';
  const progress = status && status.backfill.total > 0
    ? t('project.progress', { done: status.backfill.done, total: status.backfill.total })
    : indexing
      ? t('project.indexing')
      : null;

  return (
    <SettingsCard title={t('project.title')}>
      <div id={PROJECT_DIMENSION_CARD_ID} ref={cardRef} tabIndex={-1}>
        <SettingsGroup>
          <SettingsToggleRow
            label={t('project.toggle')}
            hint={t('project.toggleHint')}
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
            <p className="settings-project-note" role="status">{t('project.reconfirm')}</p>
          )}
          {progress && <p className="settings-project-note" role="status">{progress}</p>}
          {status?.state === 'ready' && (
            <p className="settings-project-note" role="status">
              {t('project.ready', { projects: status.namedProjects, sessions: status.indexedSessions })}
            </p>
          )}
          {status?.state === 'failed' && (
            <p className="settings-project-note" role="alert">
              {projectFailureCopy(status.lastFailure)}
              <button className="secondary-inline" type="button" onClick={() => void rebuild()} disabled={busy}>{t('project.retryIndex')}</button>
            </p>
          )}
          {purgeNote && <p className="settings-project-note" role="status">{purgeNote}</p>}
          {error && (
            <p className="settings-project-note" role="alert">
              {error}
              <button className="ghost-inline" type="button" onClick={() => void refresh()}>{t('project.retryRead')}</button>
            </p>
          )}
          <SettingsToggleRow
            label={t('project.hide')}
            hint={t('project.hideHint')}
            icon={EyeOff}
            checked={hidden}
            onChange={setHidden}
          />
          <DisclosurePanel title={t('project.details')}>
            <div className="settings-project-copy">
              <h4>{t('project.reads')}</h4>
              <ul>
                <li>{t('project.read1')}</li>
                <li>{t('project.read2')}</li>
              </ul>
              <h4>{t('project.notRead')}</h4>
              <ul>
                <li>{t('project.not1')}</li>
                <li>{t('project.not2')}</li>
                <li>{t('project.not3')}</li>
                <li>{t('project.not4')}</li>
              </ul>
              <h4>{t('project.limits')}</h4>
              <ul>
                <li>{t('project.limit1')}</li>
                <li>{t('project.limit2')}</li>
                <li>{t('project.limit3')}</li>
                <li>{t('project.limit4')}</li>
              </ul>
            </div>
          </DisclosurePanel>
        </SettingsGroup>
      </div>
      {pending === 'enable' && (
        <ConfirmDialog
          title={t('project.enableTitle')}
          description={t('project.enableDescription')}
          confirmLabel={t('project.enableConfirm')}
          cancelLabel={t('project.cancel')}
          onCancel={() => setPending(null)}
          onConfirm={() => void confirm()}
        />
      )}
      {pending === 'disable' && (
        <ConfirmDialog
          title={t('project.disableTitle')}
          description={t('project.disableDescription', { projects: status?.namedProjects ?? 0, sessions: status?.indexedSessions ?? 0 })}
          confirmLabel={t('project.disableConfirm')}
          cancelLabel={t('project.keep')}
          tone="danger"
          onCancel={() => setPending(null)}
          onConfirm={() => void confirm()}
        />
      )}
    </SettingsCard>
  );
}
