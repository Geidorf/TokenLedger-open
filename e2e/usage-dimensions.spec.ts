import { expect, expectNoHorizontalOverflow, openPage, test } from './fixtures';

const off = { state: 'off', lastUploadedAt: null, error: null };

for (const viewport of [{ width: 1200, height: 800 }, { width: 1280, height: 860 }]) {
  for (const lang of ['zh', 'en'] as const) {
    test(`用量维度：默认关闭、保存及待清理说明 ${lang} ${viewport.width}`, async ({ page, ipc }, testInfo) => {
      await page.setViewportSize(viewport);
      await openPage(page, 'settings-data', `?lang=${lang}`);
      const title = lang === 'zh' ? '同步用量维度到手机' : 'Sync usage dimensions to phone';
      const card = page.locator('.settings-card').filter({ hasText: title });
      await card.scrollIntoViewIfNeeded();
      const toggles = card.getByRole('switch');
      await expect(toggles).toHaveCount(3);
      for (const toggle of await toggles.all()) {
        await expect(toggle).toHaveAttribute('aria-checked', 'false');
      }
      await toggles.first().click();
      await expect(toggles.first()).toHaveAttribute('aria-checked', 'true');
      await expect(card).toContainText(lang === 'zh' ? '已同步' : 'Synced');
      const saves = await ipc.calls('save_settings');
      expect((saves.at(-1)!.args as { settings: Record<string, unknown> }).settings).toMatchObject({
        usage_dimension_sessions_enabled: true,
        usage_dimension_providers_enabled: false,
        usage_dimension_context_enabled: false,
      });

      await ipc.override('usage_dimensions_publish_status', {
        value: { sessions: { ...off, state: 'clearing' }, providers: off, context: off },
      });
      await toggles.first().click();
      await expect(toggles.first()).toHaveAttribute('aria-checked', 'false');
      await expect(card).toContainText(lang === 'zh' ? '正在清理当前账号' : 'Clearing this dimension');
      await expectNoHorizontalOverflow(page);
      await card.screenshot({ path: testInfo.outputPath(`dimensions-${lang}-${viewport.width}.png`) });
    });
  }
}
