import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    // 提前转换启动 mock 与设置页，避免首次访问时动态 import 串行等待。
    warmup: {
      clientFiles: ['./src/devMockTauri.ts', './src/components/SettingsTab.tsx'],
    },
    // cargo build/test 往 src-tauri/target 写入的 codegen 资产会被默认监听捕获，
    // 触发整页 reload；Rust 侧编译时 `tauri dev` / `vite` 页面会反复闪白。
    watch: {
      ignored: ['**/src-tauri/target/**'],
    },
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    target: process.env.TAURI_PLATFORM === 'windows' ? 'chrome105' : (process.env.TAURI_PLATFORM === 'macos' ? 'safari15' : 'es2020'),
    minify: !process.env.TAURI_DEBUG ? 'esbuild' : false,
    sourcemap: !!process.env.TAURI_DEBUG,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('react') || id.includes('react-dom')) return 'react';
          // Keep the chart engine and renderer cacheable as separate lazy chunks.
          // scripts/check-bundle-budget.mjs guards both chunks and their aggregate.
          if (id.includes('zrender')) return 'chart-renderer';
          if (
            id.includes('/echarts/lib/chart/heatmap/')
            || id.includes('/echarts/lib/component/visualMap/')
          ) return 'prototype-chart-extras';
          if (id.includes('echarts')) return 'charts';
          if (id.includes('lucide-react') || id.includes('lucide')) return 'icons';
          if (id.includes('@tauri-apps')) return 'tauri';
          return 'vendor';
        },
      },
    },
  },
});
