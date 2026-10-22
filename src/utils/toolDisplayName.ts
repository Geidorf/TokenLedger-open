import fixture from '../../fixtures/tool-display-names-v1/names.json';

/**
 * 工具 id → 显示名。看板、挂件、静态壁纸读同一份
 * `fixtures/tool-display-names-v1/names.json`（TOKE-12）。
 *
 * 先按 `String.prototype.trim` 去空白再转小写；命中表或别名就用表内名字，
 * 否则只把首字母大写。空名写「未命名工具」。扫描器写入的 id 不在这里改写。
 */
const NAMES: Record<string, string> = fixture.names;
const ALIASES: Record<string, string> = fixture.aliases;
const EMPTY_LABEL = fixture.emptyLabel;

function capitalizeFirst(value: string): string {
  if (!value) return value;
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function toolDisplayName(name: string): string {
  const trimmed = (name ?? '').trim();
  const key = trimmed.toLowerCase();
  const known = NAMES[key];
  if (known) return known;
  const canonical = ALIASES[key];
  if (canonical) return NAMES[canonical] ?? capitalizeFirst(canonical);
  if (!trimmed) return EMPTY_LABEL;
  return capitalizeFirst(trimmed);
}
