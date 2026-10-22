import type { CustomDateRange, DataScope, RangeKey } from '../../types';
import { CloudDeviceSelect, RangeControl, ShareCardButton, TokenModeToggle } from '../RangeControls';

export interface UsageToolbarProps {
  /** 概览带口径与战报；记录只按同一范围与设备取数，不显示这两项。 */
  variant: 'overview' | 'records';
  dataScope: DataScope;
  range: RangeKey;
  customRange: CustomDateRange | null;
  onRangeChange: (range: RangeKey, bounds?: CustomDateRange | null) => void;
  deviceFilter: string;
  deviceList: string[];
  onDeviceFilterChange: (filter: string) => void;
  showTotalTokens: boolean;
  onToggleTokenMode: () => void;
  cachedTokens?: number;
  onOpenShareCard?: () => void;
  now?: () => Date;
}

/** 用量页概览 / 记录的页内工具行（T10.276）：与行为分析的范围栏同处子标签下方第一行。 */
export function UsageToolbar({
  variant,
  dataScope,
  range,
  customRange,
  onRangeChange,
  deviceFilter,
  deviceList,
  onDeviceFilterChange,
  showTotalTokens,
  onToggleTokenMode,
  cachedTokens,
  onOpenShareCard,
  now,
}: UsageToolbarProps) {
  return (
    <div className="usage-toolbar" role="group" aria-label={variant === 'overview' ? '概览范围与口径' : '记录范围'}>
      <RangeControl range={range} customRange={customRange} onRangeChange={onRangeChange} now={now} />
      {dataScope === 'cloud' && (
        <CloudDeviceSelect deviceFilter={deviceFilter} deviceList={deviceList} onDeviceFilterChange={onDeviceFilterChange} />
      )}
      {variant === 'overview' && (
        <>
          <span className="usage-flex" />
          <TokenModeToggle showTotalTokens={showTotalTokens} onToggleTokenMode={onToggleTokenMode} cachedTokens={cachedTokens} />
          {onOpenShareCard && <ShareCardButton onOpenShareCard={onOpenShareCard} />}
        </>
      )}
    </div>
  );
}
