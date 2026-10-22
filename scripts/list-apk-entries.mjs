// 列出 APK（zip）内的条目与体积分组，用于人工核对产物完整性。
// 用法：node scripts/list-apk-entries.mjs <apk>
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const file = process.argv[2];
if (!file) {
  console.error('用法：node scripts/list-apk-entries.mjs <apk>');
  process.exit(2);
}
const buf = fs.readFileSync(file);

// 定位 End of Central Directory
let eocd = -1;
for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
  if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
}
if (eocd < 0) { console.error('不是有效的 zip/APK'); process.exit(1); }

const count = buf.readUInt16LE(eocd + 10);
let off = buf.readUInt32LE(eocd + 16);
const groups = new Map();
let total = 0;

for (let i = 0; i < count; i++) {
  if (buf.readUInt32LE(off) !== 0x02014b50) break;
  const method = buf.readUInt16LE(off + 10);
  const compSize = buf.readUInt32LE(off + 20);
  const nameLen = buf.readUInt16LE(off + 28);
  const extraLen = buf.readUInt16LE(off + 30);
  const commentLen = buf.readUInt16LE(off + 32);
  const localOff = buf.readUInt32LE(off + 42);
  const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
  const key = name.split('/')[0] || '(root)';
  groups.set(key, (groups.get(key) || 0) + compSize);
  total += compSize;
  off += 46 + nameLen + extraLen + commentLen;
}

console.log(`${path.basename(file)}  entries=${count}  compressed=${(total / 1048576).toFixed(2)} MB`);
for (const [k, v] of [...groups].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(24)} ${(v / 1048576).toFixed(2)} MB`);
}
