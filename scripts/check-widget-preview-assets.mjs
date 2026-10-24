import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const providerNames = [
  'token_ledger_bar_widget_info.xml',
  'token_ledger_combo_widget_info.xml',
  'token_ledger_quota_widget_info.xml',
  'token_ledger_ring_widget_info.xml',
  'token_ledger_widget_info.xml',
];

const failures = [];

function readText(relativePath) {
  const absolutePath = path.join(root, relativePath);
  if (!fs.existsSync(absolutePath)) {
    failures.push(`缺少文件：${relativePath}`);
    return '';
  }
  return fs.readFileSync(absolutePath, 'utf8');
}

function attribute(xml, name, relativePath) {
  const match = xml.match(new RegExp(`android:${name}="([^"]+)"`));
  if (!match) failures.push(`${relativePath} 缺少 android:${name}`);
  return match?.[1] ?? '';
}

function resourceName(value, type, relativePath) {
  const prefix = `@${type}/`;
  if (!value.startsWith(prefix)) {
    failures.push(`${relativePath} 的 ${type} 资源引用非法：${value}`);
    return '';
  }
  return value.slice(prefix.length);
}

function pngSize(relativePath) {
  const absolutePath = path.join(root, relativePath);
  if (!fs.existsSync(absolutePath)) {
    failures.push(`缺少 PNG：${relativePath}`);
    return null;
  }
  const buffer = fs.readFileSync(absolutePath);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(signature)) {
    failures.push(`${relativePath} 不是有效 PNG`);
    return null;
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

for (const providerName of providerNames) {
  const providerPath = path.join('apps', 'android', 'app', 'src', 'main', 'res', 'xml', providerName);
  const xml = readText(providerPath);
  if (!xml) continue;
  if (xml.includes('previewImage 暂缺')) {
    failures.push(`${providerPath} 仍保留“previewImage 暂缺”过期说明`);
  }

  const imageName = resourceName(attribute(xml, 'previewImage', providerPath), 'drawable', providerPath);
  const layoutName = resourceName(attribute(xml, 'previewLayout', providerPath), 'layout', providerPath);
  const width = Number(attribute(xml, 'targetCellWidth', providerPath));
  const height = Number(attribute(xml, 'targetCellHeight', providerPath));
  const imagePath = path.join('apps', 'android', 'app', 'src', 'main', 'res', 'drawable', `${imageName}.png`);
  const layoutPath = path.join('apps', 'android', 'app', 'src', 'main', 'res', 'layout', `${layoutName}.xml`);
  const size = imageName ? pngSize(imagePath) : null;
  const layout = layoutName ? readText(layoutPath) : '';

  if (imageName && layout && !layout.includes(`android:src="@drawable/${imageName}"`)) {
    failures.push(`${providerPath} 与 ${layoutPath} 指向了不同的 previewImage`);
  }
  if (layoutName && layout && !layout.includes('android:contentDescription=')) {
    failures.push(`${layoutPath} 缺少预览图 contentDescription`);
  }
  if (size && Number.isFinite(width) && Number.isFinite(height) && height > 0) {
    const actualRatio = size.width / size.height;
    const targetRatio = width / height;
    if (Math.abs(actualRatio - targetRatio) > 0.01) {
      failures.push(`${imagePath} 比例 ${size.width}×${size.height} 不匹配 targetCell ${width}×${height}`);
    }
  }

  if (size) {
    console.log(`通过：${providerName} -> ${imageName}.png (${size.width}×${size.height}) / ${layoutName}.xml`);
  }
}

if (failures.length > 0) {
  console.error('\nAndroid 小组件预览资源契约失败：');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log('Android 小组件预览资源契约通过。');
