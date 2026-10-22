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
import zlib from 'node:zlib';

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

// 明确标注为占位符的公开构建配置：不含任何真实租户，公开版需要贡献者自建
// Supabase 项目后重新编译，因此允许出现在产物里。真实 key 绝不能进白名单。
const ALLOWED_PLACEHOLDERS = [
  'sb_publishable_placeholder0000000000000000000000000000',
  'placeholder-project-ref.supabase.co',
];


// APK 是 zip，APK 里的内容在压缩流中，直接按 latin1 扫会漏。APK 走「解 dex 再扫」。
function readScannable(file) {
  const head = fs.readFileSync(file).subarray(0, 4);
  const isZip = head[0] === 0x50 && head[1] === 0x4b;
  if (!isZip) return fs.readFileSync(file).toString('latin1');

  const buf = fs.readFileSync(file);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return '';

  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  let text = '';
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    if (name.endsWith('.dex')) {
      const ln = buf.readUInt16LE(localOff + 26);
      const le = buf.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + ln + le;
      const raw = buf.subarray(dataStart, dataStart + compSize);
      try {
        text += method === 0 ? raw.toString('latin1') : zlib.inflateRawSync(raw).toString('latin1');
      } catch {
        text += raw.toString('latin1');
      }
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  return text;
}

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
  const text = readScannable(file);
  // 先剔除显式允许的占位符，再判定命中，避免把占位符误报成真实凭据。
  const scrubbed = ALLOWED_PLACEHOLDERS.reduce((acc, p) => acc.split(p).join(''), text);
  const hits = FORBIDDEN.filter((rule) => rule.pattern.test(scrubbed)).map((rule) => rule.label);
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
