import { afterEach, expect, it, vi } from 'vitest';
import { ensureShareCardAssetsReady, SHARE_METRIC_ICON_ASSETS } from './shareCardRenderer';

afterEach(() => vi.unstubAllGlobals());

it('应用位图不可用时海报仍能准备完成，只加载实际绘制的资源', async () => {
  const requested: string[] = [];
  class TestImage {
    complete = true;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(value: string) {
      requested.push(value);
      queueMicrotask(() => {
        if (value.includes('tokenledger-app-icon')) this.onerror?.();
        else this.onload?.();
      });
    }
  }
  vi.stubGlobal('Image', TestImage);

  await expect(ensureShareCardAssetsReady()).resolves.toBeUndefined();
  expect(requested).toEqual(SHARE_METRIC_ICON_ASSETS.map(({ url }) => url));
});
