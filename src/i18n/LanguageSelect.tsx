import { setLangPreference, useLangPreference, useT, type LangPreference } from '.';

const OPTIONS: { value: LangPreference; key: 'language.option.zh' | 'language.option.en' | 'language.option.system' }[] = [
  { value: 'zh', key: 'language.option.zh' },
  { value: 'en', key: 'language.option.en' },
  { value: 'system', key: 'language.option.system' },
];

/** Interface language picker; the choice applies at once and is kept in this browser profile. */
export function LanguageSelect({ className = 'settings-select' }: { className?: string }) {
  const t = useT();
  const preference = useLangPreference();
  return (
    <select
      className={className}
      aria-label={t('language.switch.label')}
      value={preference}
      onChange={(event) => setLangPreference(event.target.value as LangPreference)}
    >
      {OPTIONS.map((option) => <option key={option.value} value={option.value}>{t(option.key)}</option>)}
    </select>
  );
}
