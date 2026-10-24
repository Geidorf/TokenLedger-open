import assert from 'node:assert/strict';
import test from 'node:test';
import { rewriteLink, rewriteMarkdown } from './build-guide-site.mjs';

const REPO = 'https://github.com/o/r';

test('手册内的链接保持相对', () => {
  assert.equal(rewriteLink('02-first-run.md', 'zh/01-install.md', REPO), '02-first-run.md');
  assert.equal(rewriteLink('../images/a.png', 'zh/01-install.md', REPO), '../images/a.png');
  assert.equal(rewriteLink('zh/README.md', 'README.md', REPO), 'zh/README.md');
  assert.equal(rewriteLink('03-usage.md#额度', 'zh/05-budget.md', REPO), '03-usage.md#额度');
});

test('指向手册以外的链接改成仓库绝对地址，保留锚点', () => {
  assert.equal(rewriteLink('../../../README.md#隐私', 'zh/09-privacy.md', REPO), `${REPO}/blob/main/README.md#隐私`);
  assert.equal(rewriteLink('../../design/x.md', 'en/09-privacy.md', REPO), `${REPO}/blob/main/docs/design/x.md`);
  assert.equal(rewriteLink('../../README.md', 'README.md', REPO), `${REPO}/blob/main/README.md`);
});

test('外链、页内锚点不动；越出仓库报错', () => {
  assert.equal(rewriteLink('https://supabase.com', 'zh/06-cloud-mobile.md', REPO), 'https://supabase.com');
  assert.equal(rewriteLink('#windows', 'zh/10-faq.md', REPO), '#windows');
  assert.throws(() => rewriteLink('../../../../x.md', 'zh/a.md', REPO));
});

test('Markdown 链接与 HTML 属性都会改写', () => {
  const text = '[a](../../../SECURITY.md) <img src="../images/x.png"> [b](01-install.md)';
  assert.equal(
    rewriteMarkdown(text, 'en/10-faq.md', REPO),
    `[a](${REPO}/blob/main/SECURITY.md) <img src="../images/x.png"> [b](01-install.md)`,
  );
});
