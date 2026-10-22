// 从 APK（zip）中提取 .dex 文件，用于核对编译进包的实际配置值。
// 用法：node scripts/extract-apk-dex.mjs <apk> <outDir>
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const [apk, outDir] = process.argv.slice(2);
if (!apk || !outDir) {
  console.error('用法：node scripts/extract-apk-dex.mjs <apk> <outDir>');
  process.exit(2);
}

const buf = fs.readFileSync(apk);
let eocd = -1;
for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
  if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
}
if (eocd < 0) { console.error('不是有效的 zip/APK'); process.exit(1); }

fs.mkdirSync(outDir, { recursive: true });
const count = buf.readUInt16LE(eocd + 10);
let off = buf.readUInt32LE(eocd + 16);

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
    const out = method === 0 ? raw : zlib.inflateRawSync(raw);
    const dest = path.join(outDir, path.basename(name));
    fs.writeFileSync(dest, out);
    console.log(`extracted ${path.basename(name)} ${out.length} bytes`);
  }
  off += 46 + nameLen + extraLen + commentLen;
}
