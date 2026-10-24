// 把插件打成 .vsix，供「从 VSIX 安装」使用。不发布到扩展市场。
//
// .vsix 就是一个 zip：根目录放 [Content_Types].xml 与 extension.vsixmanifest，插件文件放在
// extension/ 下。这里用 Node 自带的 zlib 直接写 zip，不引入打包工具依赖，离线可用。
//
// 用法（在 extensions/vscode 目录）：npm run package [-- --out 文件]
// 产物默认 dist/tokenledger-status-<版本>.vsix，并打印 SHA-256。

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(extensionRoot, '..', '..');

// 进包的文件：路径相对插件目录，或指向仓库里现成的文件（许可证、应用图标），不复制一份进仓库。
export function packageEntries() {
  const sources = fs.readdirSync(path.join(extensionRoot, 'src'))
    .filter((name) => name.endsWith('.js'))
    .sort()
    .map((name) => ({ archive: `extension/src/${name}`, file: path.join(extensionRoot, 'src', name) }));
  return [
    { archive: 'extension/package.json', file: path.join(extensionRoot, 'package.json') },
    { archive: 'extension/README.md', file: path.join(extensionRoot, 'README.md') },
    { archive: 'extension/LICENSE.txt', file: path.join(repoRoot, 'LICENSE') },
    { archive: 'extension/media/icon.png', file: path.join(repoRoot, 'src-tauri', 'icons', '128x128.png') },
    ...sources,
  ];
}

function xmlEscape(text) {
  return String(text).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]);
}

export function vsixManifest(manifest) {
  const engine = manifest.engines && manifest.engines.vscode;
  const kind = Array.isArray(manifest.extensionKind) ? manifest.extensionKind.join(',') : (manifest.extensionKind || 'workspace');
  return `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="${xmlEscape(manifest.name)}" Version="${xmlEscape(manifest.version)}" Publisher="${xmlEscape(manifest.publisher)}" />
    <DisplayName>${xmlEscape(manifest.displayName || manifest.name)}</DisplayName>
    <Description xml:space="preserve">${xmlEscape(manifest.description || '')}</Description>
    <Tags>${xmlEscape((manifest.keywords || []).join(','))}</Tags>
    <Categories>${xmlEscape((manifest.categories || []).join(','))}</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${xmlEscape(engine)}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="${xmlEscape(kind)}" />
      <Property Id="Microsoft.VisualStudio.Code.LocalizedLanguages" Value="" />
      <Property Id="Microsoft.VisualStudio.Services.Links.Source" Value="${xmlEscape(manifest.repository && manifest.repository.url)}" />
      <Property Id="Microsoft.VisualStudio.Services.GitHubFlavoredMarkdown" Value="true" />
      <Property Id="Microsoft.VisualStudio.Services.Content.Pricing" Value="Free" />
    </Properties>
    <License>extension/LICENSE.txt</License>
    <Icon>extension/media/icon.png</Icon>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE.txt" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Icons.Default" Path="extension/media/icon.png" Addressable="true" />
  </Assets>
</PackageManifest>
`;
}

const CONTENT_TYPES = {
  '.json': 'application/json',
  '.js': 'application/javascript',
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.png': 'image/png',
  '.vsixmanifest': 'text/xml',
};

export function contentTypesXml(archiveNames) {
  const extensions = [...new Set(archiveNames.map((name) => path.posix.extname(name)).filter(Boolean))].sort();
  const defaults = extensions.map((ext) => {
    const type = CONTENT_TYPES[ext];
    if (!type) throw new Error(`没有登记 ${ext} 的内容类型`);
    return `<Default Extension="${ext}" ContentType="${type}" />`;
  });
  return `<?xml version="1.0" encoding="utf-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${defaults.join('')}</Types>\n`;
}

// ---------------------------------------------------------------- zip

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// 固定的 DOS 时间（1980-01-01 00:00），同样的输入得到逐字节相同的包，便于核对 SHA-256。
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;

/** 写一个 zip：`entries` 为 `{ name, data }`，按给定顺序，deflate 压缩，文件名 UTF-8。 */
export function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const compressed = zlib.deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // 解压所需版本 2.0
    local.writeUInt16LE(0x0800, 6); // 文件名是 UTF-8
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBytes, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);

    offset += local.length + nameBytes.length + compressed.length;
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

export function buildVsix() {
  const manifest = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'package.json'), 'utf8'));
  for (const key of ['name', 'version', 'publisher', 'main']) {
    if (!manifest[key]) throw new Error(`package.json 缺少 ${key}`);
  }
  const files = packageEntries().map(({ archive, file }) => {
    if (!fs.existsSync(file)) throw new Error(`缺少要打包的文件：${path.relative(repoRoot, file)}`);
    return { name: archive, data: fs.readFileSync(file) };
  });
  const names = files.map((file) => file.name);
  if (!names.includes(`extension/${manifest.main.replace(/^\.\//, '')}`)) {
    throw new Error(`入口 ${manifest.main} 不在包里`);
  }
  const entries = [
    { name: 'extension.vsixmanifest', data: Buffer.from(vsixManifest(manifest), 'utf8') },
    { name: '[Content_Types].xml', data: Buffer.from(contentTypesXml(['extension.vsixmanifest', ...names]), 'utf8') },
    ...files,
  ];
  return { manifest, buffer: buildZip(entries), names: entries.map((entry) => entry.name) };
}

function main(argv) {
  const outIndex = argv.indexOf('--out');
  const { manifest, buffer, names } = buildVsix();
  const out = outIndex >= 0 && argv[outIndex + 1]
    ? path.resolve(argv[outIndex + 1])
    : path.join(extensionRoot, 'dist', `${manifest.name}-${manifest.version}.vsix`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, buffer);
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  console.log(`已生成 ${path.relative(process.cwd(), out) || out}（${names.length} 个文件，${buffer.length} 字节）`);
  console.log(`SHA-256 ${sha256}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
