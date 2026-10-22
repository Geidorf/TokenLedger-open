import { init, use } from 'echarts/core';
import { BarChart, HeatmapChart, LineChart, PieChart } from 'echarts/charts';
import { GridComponent, LegendPlainComponent, TooltipComponent, VisualMapComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

// The hidden Android interaction prototype needs the calendar heatmap, while
// the production desktop dashboard keeps its smaller runtime. Vite isolates
// Heatmap/VisualMap into an optional prototype-only chart chunk.
use([
  BarChart,
  HeatmapChart,
  LineChart,
  PieChart,
  GridComponent,
  LegendPlainComponent,
  TooltipComponent,
  VisualMapComponent,
  CanvasRenderer,
]);

export { init };
