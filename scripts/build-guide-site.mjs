#!/usr/bin/env node
// 把 docs/guide/ 整理成 GitHub Pages 用的 Jekyll 源目录（只发布用户手册，不发布 docs/ 其余内容）。
//
// 用法：node scripts/build-guide-site.mjs <输出目录> [仓库地址]
//
// - 原样复制 docs/guide/ 下的 Markdown 与图片；
// - 指向手册以外的相对链接（README、supabase/README.md 等）改成仓库里的绝对地址，
//   站点上不会出现断链；
// - 写入 _config.yml。.md 之间的链接由 Pages 默认启用的 jekyll-relative-links 转成 .html，
//   README.md 由 jekyll-readme-index 当作目录首页。
//
// 本脚本只读仓库，只写输出目录。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GUIDE = path.join(ROOT, 'docs/guide');
const DEFAULT_REPO = 'https://github.com/Geidorf/TokenLedger-open';

export function rewriteLink(target, fileRel, repoUrl) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#') || target.startsWith('/')) return target;
  const [pathPart, hash = ''] = target.split(/(?=#)/);
  const fromRepoRoot = path.posix.normalize(path.posix.join('docs/guide', path.posix.dirname(fileRel), pathPart));
  if (fromRepoRoot === 'docs/guide' || fromRepoRoot.startsWith('docs/guide/')) return target;
  if (fromRepoRoot.startsWith('..')) throw new Error(`${fileRel}: 链接 ${target} 指到仓库外`);
  return `${repoUrl}/blob/main/${fromRepoRoot}${hash}`;
}

export function rewriteMarkdown(text, fileRel, repoUrl) {
  return text
    .replace(/(\]\()([^)\s]+)(\))/g, (_, open, target, close) => open + rewriteLink(target, fileRel, repoUrl) + close)
    .replace(/(\b(?:src|href)=")([^"]+)(")/g, (_, open, target, close) => open + rewriteLink(target, fileRel, repoUrl) + close);
}

function copyTree(from, to, rel, repoUrl) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) copyTree(src, dest, entryRel, repoUrl);
    else if (entry.name.endsWith('.md')) fs.writeFileSync(dest, rewriteMarkdown(fs.readFileSync(src, 'utf8'), entryRel, repoUrl));
    else fs.copyFileSync(src, dest);
  }
}

const CONFIG = `title: TokenLedger
description: TokenLedger 用户手册 · User Guide
theme: jekyll-theme-primer
plugins:
  - jekyll-relative-links
  - jekyll-readme-index
relative_links:
  enabled: true
`;

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = process.argv[2];
  if (!out) {
    console.error('用法：node scripts/build-guide-site.mjs <输出目录> [仓库地址]');
    process.exit(1);
  }
  const repoUrl = (process.argv[3] || DEFAULT_REPO).replace(/\/$/, '');
  fs.rmSync(out, { recursive: true, force: true });
  copyTree(GUIDE, out, '', repoUrl);
  fs.writeFileSync(path.join(out, '_config.yml'), CONFIG);
  console.log(`用户手册站点源目录已写入 ${out}`);
}
