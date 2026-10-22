import { init, use } from 'echarts/core';
import { BarChart, LineChart, PieChart } from 'echarts/charts';
import { GridComponent, LegendPlainComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

// Register only the chart families TokenLedger renders. Keeping this behind
// EChart's dynamic import preserves the dashboard's quick first paint while
// avoiding the full all-in-one ECharts bundle. Every current legend is plain;
// add LegendScrollComponent here if a future option explicitly uses scroll.
use([
  BarChart,
  LineChart,
  PieChart,
  GridComponent,
  LegendPlainComponent,
  TooltipComponent,
  CanvasRenderer,
]);

export { init };
