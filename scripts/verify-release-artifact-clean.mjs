#!/usr/bin/env node
// 扫描构建产物，确认不含发布前禁止外泄的字符串。
//
// 用途：安装包由 include_str! 把 cloud.defaults.json 编译进二进制，
// 凭据与内网地址会随产物一起分发。本脚本在上传前做最后一道核验。
//
// 用法：node scripts/verify-release-artifact-clean.mjs [--require-list] <file> [...]
// 退出码：0 = 全部干净；1 = 命中禁止字符串（禁止上传）；2 = 用法错误，或本机清单缺失（--require-list）、无法解析。
//
// 维护者自己的标识（生产 project_ref、邮箱、用户名、个人路径、内网地址等）不写进仓库，
// 否则这份清单本身就是泄露。它们放在本机清单里，按顺序取第一个存在的来源：
//   1. 环境变量 TOKENLEDGER_FORBIDDEN_JSON：清单 JSON 原文（CI 从 secret 注入）
//   2. 环境变量 TOKENLEDGER_FORBIDDEN_FILE：清单文件路径
//   3. ~/.config/tokenledger/release-forbidden.json
// 清单格式：[{ "value": "要拦截的原文", "label": "命中时显示的名称" }]，按原文不区分大小写匹配；
// 产物按 latin1 读取，value 应为 ASCII。没有清单时只跑下方通用规则并给出警告，
// 上传前的正式核验请加 --require-list。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

// 通用规则：不含任何具体身份，对任何人的产物都适用。
const GENERIC_RULES = [
  { pattern: /sb_publishable_[A-Za-z0-9_-]{30,}/u, label: 'Supabase publishable key' },
  { pattern: /sb_secret_[A-Za-z0-9_-]{30,}/u, label: 'Supabase secret key' },
  // 注意：JS 正则字面量里要匹配一个反斜杠须写四个（`\\\\` → 正则源 `\\` → 匹配一个 `\`）。
  // 写成 `\\` 会退化成「C:Users」而误报二进制里无关的字节序列。
  { pattern: /C:\\\\Users\\\\(?!Administrator\\\\)[A-Za-z0-9._-]+/iu, label: '本机用户路径' },
];

const DEFAULT_LIST_FILE = path.join(os.homedir(), '.config', 'tokenledger', 'release-forbidden.json');

// 读本机清单。没有任何来源时返回 null；来源存在但内容不合法时抛错，避免静默降级。
function loadLocalList() {
  let raw;
  let source;
  if (process.env.TOKENLEDGER_FORBIDDEN_JSON) {
    raw = process.env.TOKENLEDGER_FORBIDDEN_JSON;
    source = '环境变量 TOKENLEDGER_FORBIDDEN_JSON';
  } else if (process.env.TOKENLEDGER_FORBIDDEN_FILE) {
    if (!fs.existsSync(process.env.TOKENLEDGER_FORBIDDEN_FILE)) {
      throw new Error('TOKENLEDGER_FORBIDDEN_FILE 指向的文件不存在');
    }
    raw = fs.readFileSync(process.env.TOKENLEDGER_FORBIDDEN_FILE, 'utf8');
    source = '环境变量 TOKENLEDGER_FORBIDDEN_FILE 指向的文件';
  } else if (fs.existsSync(DEFAULT_LIST_FILE)) {
    raw = fs.readFileSync(DEFAULT_LIST_FILE, 'utf8');
    source = '~/.config/tokenledger/release-forbidden.json';
  } else {
    return null;
  }
  const list = JSON.parse(raw);
  if (!Array.isArray(list) || list.some((item) => typeof item?.value !== 'string' || item.value === '')) {
    throw new Error('清单必须是 [{ "value": "...", "label": "..." }] 数组，value 不能为空');
  }
  const rules = list.map((item) => ({ value: item.value.toLowerCase(), label: item.label || '本机清单条目' }));
  return { source, rules };
}

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

const args = process.argv.slice(2);
const requireList = args.includes('--require-list');
const files = args.filter((arg) => arg !== '--require-list');
if (files.length === 0) {
  console.error('用法：node scripts/verify-release-artifact-clean.mjs [--require-list] <file> [...]');
  process.exit(2);
}

let local;
try {
  local = loadLocalList();
} catch (error) {
  console.error(`✗ 本机清单无法读取：${error.message}`);
  process.exit(2);
}
if (local) {
  console.log(`已加载本机清单（${local.rules.length} 条，来源：${local.source}）`);
} else if (requireList) {
  console.error('✗ 未找到本机清单；--require-list 要求先按脚本开头的说明准备清单。');
  process.exit(2);
} else {
  console.warn('⚠ 未找到本机清单，只做了通用检查；上传前的正式核验请加 --require-list。');
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
  const hits = GENERIC_RULES.filter((rule) => rule.pattern.test(scrubbed)).map((rule) => rule.label);
  if (local) {
    const lowered = scrubbed.toLowerCase();
    hits.push(...local.rules.filter((rule) => lowered.includes(rule.value)).map((rule) => rule.label));
  }
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
