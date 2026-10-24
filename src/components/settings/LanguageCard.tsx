import { Languages } from 'lucide-react';
import { useT } from '../../i18n';
import { LanguageSelect } from '../../i18n/LanguageSelect';
import { SettingsCard, SettingsGroup, SettingsRow } from './SettingsPrimitives';

/** Settings › Data & help: interface language. Kept in this browser profile, not in synced settings. */
export function LanguageCard() {
  const t = useT();
  return (
    <SettingsCard title={t('language.card.title')}>
      <SettingsGroup>
        <SettingsRow label={t('language.switch.label')} hint={t('language.card.hint')} icon={Languages}>
          <LanguageSelect />
        </SettingsRow>
      </SettingsGroup>
    </SettingsCard>
  );
}
