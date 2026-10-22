#!/usr/bin/env node
// 扫描构建产物，确认不含发布前禁止外泄的字符串。
//
// 用途：安装包由 include_str! 把 cloud.defaults.json 编译进二进制，
// 凭据与内网地址会随产物一起分发。本脚本在上传前做最后一道核验。
//
// 用法：node scripts/verify-release-artifact-clean.mjs <file> [...]
// 退出码：0 = 全部干净；1 = 命中禁止字符串（禁止上传）。

import fs from 'node:fs';
import path from 'node:path';

const FORBIDDEN = [
  // 真实 Supabase 生产项目标识与 publishable key
  { pattern: /REDACTED-PROJECT-REF/iu, label: 'Supabase 生产 project_ref' },
  { pattern: /sb_publishable_[A-Za-z0-9_-]{30,}/u, label: 'Supabase publishable key' },
  { pattern: /sb_secret_[A-Za-z0-9_-]{30,}/u, label: 'Supabase secret key' },
  // 真实邮箱
  { pattern: /REDACTED-EMAIL/iu, label: '维护者邮箱' },
  // 真实用户名与个人路径
  { pattern: /REDACTED-USERNAME/iu, label: '真实用户名' },
  { pattern: /REDACTED-HOME-PATH/u, label: '个人绝对路径' },
  // 注意：JS 正则字面量里要匹配一个反斜杠须写四个（`\\\\` → 正则源 `\\` → 匹配一个 `\`）。
  // 写成 `\\` 会退化成「C:Users」而误报二进制里无关的字节序列。
  { pattern: /C:\\\\Users\\\\(?!Administrator\\\\)[A-Za-z0-9._-]+/iu, label: '本机用户路径' },
  // 组织内部额度服务地址
  { pattern: /REDACTED-INTERNAL-HOST/iu, label: '组织内部额度服务地址' },
];

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('用法：node scripts/verify-release-artifact-clean.mjs <file> [...]');
  process.exit(2);
}

let failed = false;
for (const file of files) {
  if (!fs.existsSync(file)) {
    console.error(`✗ ${path.basename(file)}：文件不存在`);
    failed = true;
    continue;
  }
  // 二进制按 latin1 读，避免 utf8 解码失败；字符串扫描对字节序列同样有效。
  const text = fs.readFileSync(file).toString('latin1');
  const hits = FORBIDDEN.filter((rule) => rule.pattern.test(text)).map((rule) => rule.label);
  const size = fs.statSync(file).size;
  if (hits.length > 0) {
    console.error(`✗ ${path.basename(file)}（${size} bytes）：命中 ${hits.join('、')}`);
    failed = true;
  } else {
    console.log(`✓ ${path.basename(file)}（${size} bytes）：未命中任何禁止字符串`);
  }
}

if (failed) {
  console.error('\n产物含发布前禁止外泄的字符串，禁止上传。');
  process.exit(1);
}
console.log('\n全部产物通过清洁检查。');
