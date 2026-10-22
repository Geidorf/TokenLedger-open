import type { QuotaProviderEnvelope } from '../../types';
import { parseQuotaProviderEnvelopes } from '../../utils/contracts/quota';
import { collectQuotaHighlights, providerDisplayName } from '../../utils/quotaOverview';
import { isCompanyQuotaProvider, quotaWindowParts, selectCompanyQuotaWindows } from '../QuotaPanel';
import type { WidgetQuotaRead } from './cardModel';

/**
 * 挂件读额度（T10.192）。窗口集合与叫法都跟看板走：
 * - 公司额度来源只留看板显示的「今日」「本月」（`selectCompanyQuotaWindows`），
 *   「Key 日额度」留在契约、LKG 与同步里，不在桌面展示（DESIGN §5.4；T10.191 评审 P2-1）。
 *   窗口总数、「另有 N 个窗口」与「+N」因此与看板一致。
 * - 窗口名是「分组 窗口」，与看板同名（T10.191）；分组与窗口短名另存一份，
 *   窄格子里只截分组、不截窗口短名，两个「每周」照样分得开。
 * 额度不是挂件的主角：契约不合法时只当没有可读额度，不把统计一起拖成错误。
 */
export function readWidgetQuota(response: unknown, now: number = Date.now()): WidgetQuotaRead {
  try {
    const providers: QuotaProviderEnvelope[] = parseQuotaProviderEnvelopes(response).map((provider) => (
      isCompanyQuotaProvider(provider.providerId)
        ? { ...provider, windows: selectCompanyQuotaWindows(provider.windows) }
        : provider
    ));
    const parts: WidgetQuotaRead['parts'] = new Map();
    for (const provider of providers) {
      for (const window of provider.windows) {
        const { groupLabel, label } = quotaWindowParts(window);
        parts.set(`${provider.providerId}:${window.windowId}`, { group: groupLabel, label, observedAt: window.observedAt });
      }
    }
    const highlights = collectQuotaHighlights(providers, now, {
      providerName: (provider) => providerDisplayName(provider),
      windowLabel: (window) => {
        const { groupLabel, label } = quotaWindowParts(window);
        return groupLabel ? `${groupLabel} ${label}` : label;
      },
    });
    return {
      highlights,
      names: new Map(providers.map((provider) => [provider.providerId, providerDisplayName(provider)])),
      parts,
    };
  } catch {
    return { highlights: [], names: new Map(), parts: new Map() };
  }
}

/**
 * 整次读取失败的哨兵值：`invoke('get_local_quota_providers')` 本身被拒绝时用，
 * 不经过上面的契约解析（P2-1，T10.192 修复轮）。与契约不合法（仍是「没有来源」）分开。
 */
export function failedWidgetQuota(): WidgetQuotaRead {
  return { highlights: [], names: new Map(), parts: new Map(), failed: true };
}
