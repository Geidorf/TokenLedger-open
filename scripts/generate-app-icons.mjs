#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import {
  constants as fsConstants,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ANDROID_FOREGROUND_SCALE = 2.9;
export const ANDROID_SAFE_RADIUS = 33;

const BRAND_BLUE = '#245EDD';
const SOURCE_REL = 'src/assets/brand/tokenledger-mark.svg';
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(SCRIPT_DIR, '..');
const DENSITIES = [
  ['mdpi', 48],
  ['hdpi', 72],
  ['xhdpi', 96],
  ['xxhdpi', 144],
  ['xxxhdpi', 192],
];

const CORE_OUTPUTS = [
  ['32x32.png', 'src-tauri/icons/32x32.png'],
  ['128x128.png', 'src-tauri/icons/128x128.png'],
  ['128x128@2x.png', 'src-tauri/icons/128x128@2x.png'],
  ['icon.icns', 'src-tauri/icons/icon.icns'],
  ['icon.ico', 'src-tauri/icons/icon.ico'],
];

function fail(message) {
  throw new Error(message);
}

function formatNumber(value) {
  return Number(value.toFixed(12)).toString();
}

function parseArgs(argv) {
  const options = { check: false, root: DEFAULT_ROOT, tauriCli: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--check') {
      options.check = true;
    } else if (argument === '--root') {
      options.root = resolve(argv[++index] ?? fail('--root 缺少路径'));
    } else if (argument === '--tauri-cli') {
      options.tauriCli = resolve(argv[++index] ?? fail('--tauri-cli 缺少路径'));
    } else {
      fail(`未知参数：${argument}`);
    }
  }
  return options;
}

function attribute(tag, name) {
  const match = tag.match(new RegExp(`\\b${name}="([^"]+)"`));
  if (!match) fail(`品牌源 SVG 缺少 ${name}`);
  return match[1];
}

function linePathBounds(path) {
  const number = '-?(?:\\d+(?:\\.\\d*)?|\\.\\d+)';
  const unsupported = path.replace(new RegExp(`[MLHV]|${number}|[\\s,]`, 'g'), '');
  if (unsupported) fail(`品牌源 path 只支持绝对 M/L/H/V 命令，发现：${unsupported}`);
  const tokens = path.match(new RegExp(`[MLHV]|${number}`, 'g')) ?? [];
  let x = 0;
  let y = 0;
  const points = [];
  const takeNumber = (index) => {
    const value = Number(tokens[index]);
    if (!Number.isFinite(value)) fail('品牌源 path 命令缺少坐标');
    return value;
  };
  for (let index = 0; index < tokens.length;) {
    const command = tokens[index++];
    if (!['M', 'L', 'H', 'V'].includes(command)) fail('品牌源 path 每段必须显式使用 M/L/H/V 命令');
    if (command === 'M' || command === 'L') {
      x = takeNumber(index++);
      y = takeNumber(index++);
    } else if (command === 'H') {
      x = takeNumber(index++);
    } else {
      y = takeNumber(index++);
    }
    points.push([x, y]);
  }
  if (points.length === 0) fail('品牌源 path 不能为空');
  return points;
}

export function parseMark(source) {
  const compact = source.replace(/\s+/g, ' ').trim();
  const svgTag = compact.match(/^<svg\b[^>]*>/)?.[0] ?? fail('品牌源文件不是 SVG');
  const pathCount = (compact.match(/<path\b/g) ?? []).length;
  if (pathCount !== 1) fail(`品牌源 SVG 必须只有一个 path，当前为 ${pathCount}`);
  const pathTag = compact.match(/<path\b[^>]*\/?\s*>/)?.[0] ?? fail('品牌源 SVG 缺少 path');
  const viewBox = attribute(svgTag, 'viewBox').trim().split(/[ ,]+/).map(Number);
  if (viewBox.length !== 4 || viewBox.some((value) => !Number.isFinite(value))) fail('品牌源 SVG 的 viewBox 非法');
  const [minX, minY, width, height] = viewBox;
  if (width <= 0 || width !== height) fail('品牌源 SVG 的 viewBox 必须是正方形');
  if (minX !== 0 || minY !== 0) fail('品牌源 SVG 的 viewBox 必须从 0 0 开始，以匹配 TS/Kotlin 消费者');
  if (attribute(svgTag, 'fill') !== 'none') fail('品牌源 SVG 必须 fill="none"');
  if (attribute(svgTag, 'stroke') !== 'currentColor') fail('品牌源 SVG 必须 stroke="currentColor"');
  if (attribute(svgTag, 'stroke-linecap') !== 'round' || attribute(svgTag, 'stroke-linejoin') !== 'round') {
    fail('品牌源 SVG 必须使用 round 线帽和连接');
  }
  const strokeWidth = Number(attribute(svgTag, 'stroke-width'));
  if (!Number.isFinite(strokeWidth) || strokeWidth <= 0) fail('品牌源 SVG 的 stroke-width 非法');
  const path = attribute(pathTag, 'd');
  const points = linePathBounds(path);
  const centerX = minX + width / 2;
  const centerY = minY + height / 2;
  const farthestPoint = Math.max(...points.map(([x, y]) => Math.hypot(x - centerX, y - centerY)));
  const inkRadius = (farthestPoint + strokeWidth / 2) * ANDROID_FOREGROUND_SCALE;
  if (inkRadius > ANDROID_SAFE_RADIUS) {
    fail(`品牌源 path 超出 Android 圆形安全区：${inkRadius.toFixed(2)}dp > ${ANDROID_SAFE_RADIUS}dp`);
  }
  return { path, strokeWidth, size: width, minX, minY, centerX, centerY, inkRadius };
}

function iconTransform(mark) {
  const scale = 648 / mark.size;
  const translateX = 512 - mark.centerX * scale;
  const translateY = 512 - mark.centerY * scale;
  return { scale, translateX, translateY };
}

function appIconSvg(mark, round = false) {
  const transform = iconTransform(mark);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><rect x="104" y="104" width="816" height="816" rx="${round ? 408 : 182}" fill="${BRAND_BLUE}"/><g transform="translate(${transform.translateX} ${transform.translateY}) scale(${transform.scale})" fill="none" stroke="#ffffff" stroke-width="${mark.strokeWidth}" stroke-linecap="round" stroke-linejoin="round"><path d="${mark.path}"/></g></svg>\n`;
}

function traySvg(mark) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="${mark.minX} ${mark.minY} ${mark.size} ${mark.size}" fill="none" stroke="#000000" stroke-width="${mark.strokeWidth}" stroke-linecap="round" stroke-linejoin="round"><path d="${mark.path}"/></svg>\n`;
}

function faviconSvg(mark) {
  const inset = mark.size / 24;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${mark.minX} ${mark.minY} ${mark.size} ${mark.size}"><style>.tile{fill:${BRAND_BLUE}}.mark{fill:none;stroke:#fff;stroke-width:${mark.strokeWidth};stroke-linecap:round;stroke-linejoin:round}</style><rect class="tile" x="${mark.minX + inset}" y="${mark.minY + inset}" width="${mark.size - inset * 2}" height="${mark.size - inset * 2}" rx="${mark.size * 5 / 24}"/><path class="mark" d="${mark.path}"/></svg>\n`;
}

function typescriptGeometry(mark) {
  return `// 由 scripts/generate-app-icons.mjs 从 tokenledger-mark.svg 生成，请勿手改。\nexport const TOKEN_LEDGER_PATH = '${mark.path}';\nexport const TOKEN_LEDGER_STROKE_WIDTH = ${mark.strokeWidth};\nexport const TOKEN_LEDGER_SIZE = ${mark.size};\n`;
}

function kotlinGeometry(mark) {
  return `// 由 scripts/generate-app-icons.mjs 从 tokenledger-mark.svg 生成，请勿手改。\npackage com.jeidorf.tokenledger.mobile\n\nobject TokenLedgerBrand {\n    const val PATH_DATA = "${mark.path}"\n    const val STROKE_WIDTH = ${mark.strokeWidth}f\n    const val SIZE = ${mark.size}f\n}\n`;
}

function vectorDrawable(mark, color) {
  const translateX = formatNumber(54 - mark.centerX * ANDROID_FOREGROUND_SCALE);
  const translateY = formatNumber(54 - mark.centerY * ANDROID_FOREGROUND_SCALE);
  return `<?xml version="1.0" encoding="utf-8"?>\n<vector xmlns:android="http://schemas.android.com/apk/res/android"\n    android:width="108dp"\n    android:height="108dp"\n    android:viewportWidth="108"\n    android:viewportHeight="108">\n    <group\n        android:translateX="${translateX}"\n        android:translateY="${translateY}"\n        android:scaleX="${ANDROID_FOREGROUND_SCALE}"\n        android:scaleY="${ANDROID_FOREGROUND_SCALE}">\n        <path\n            android:pathData="${mark.path}"\n            android:fillColor="@android:color/transparent"\n            android:strokeColor="${color}"\n            android:strokeWidth="${mark.strokeWidth}"\n            android:strokeLineCap="round"\n            android:strokeLineJoin="round" />\n    </group>\n</vector>\n`;
}

function adaptiveIcon(includeMonochrome) {
  const monochrome = includeMonochrome
    ? '\n    <monochrome android:drawable="@drawable/ic_launcher_monochrome" />'
    : '';
  return `<?xml version="1.0" encoding="utf-8"?>\n<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n    <background android:drawable="@color/tokenledger_icon_background" />\n    <foreground android:drawable="@drawable/ic_launcher_foreground" />${monochrome}\n</adaptive-icon>\n`;
}

function iconColors() {
  return `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="tokenledger_icon_background">${BRAND_BLUE}</color>\n</resources>\n`;
}

function executableCandidates(root) {
  const candidates = [];
  if (process.env.TOKENLEDGER_TAURI_CLI) candidates.push(resolve(process.env.TOKENLEDGER_TAURI_CLI));
  candidates.push(join(root, 'node_modules', '@tauri-apps', 'cli', 'tauri.js'));
  const git = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (git.status === 0) {
    const commonGitDir = resolve(root, git.stdout.trim());
    candidates.push(join(dirname(commonGitDir), 'node_modules', '@tauri-apps', 'cli', 'tauri.js'));
  }
  return candidates;
}

function resolveTauriCli(root, override) {
  const candidates = override ? [override] : executableCandidates(root);
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    fail(`找不到 @tauri-apps/cli。已检查：${candidates.join(', ')}`);
  }
  return found;
}

function runTauriIcon(cliScript, args, root) {
  const result = spawnSync(process.execPath, [cliScript, 'icon', ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 300_000,
  });
  if (result.error) fail(`Tauri 图标渲染器启动失败：${result.error.message}`);
  if (result.status !== 0) {
    const details = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    fail(`Tauri 图标渲染失败（退出码 ${result.status ?? '未知'}）：${details}`);
  }
}

function writeStage(stage, path, content) {
  const destination = join(stage, path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, content);
}

function copyStage(stage, source, target) {
  const destination = join(stage, target);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination, fsConstants.COPYFILE_FICLONE);
}

function readPngDimensions(path) {
  const data = readFileSync(path);
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (data.length < 33 || !data.subarray(0, 8).equals(signature)) fail(`${path} 不是有效 PNG`);
  if (data.toString('ascii', 12, 16) !== 'IHDR') fail(`${path} 缺少 PNG IHDR`);
  return [data.readUInt32BE(16), data.readUInt32BE(20)];
}

function validateBinary(path, kind) {
  const data = readFileSync(path);
  if (data.length < 64) fail(`${path} 为空或过小`);
  if (kind === 'icns' && data.toString('ascii', 0, 4) !== 'icns') fail(`${path} 不是有效 ICNS`);
  if (kind === 'ico' && !data.subarray(0, 4).equals(Buffer.from([0, 0, 1, 0]))) fail(`${path} 不是有效 ICO`);
}

function normalizeIcns(path) {
  const data = readFileSync(path);
  if (data.length < 8 || data.toString('ascii', 0, 4) !== 'icns' || data.readUInt32BE(4) !== data.length) {
    fail(`${path} 不是可规范化的 ICNS`);
  }
  const chunks = [];
  let offset = 8;
  while (offset < data.length) {
    if (offset + 8 > data.length) fail(`${path} 的 ICNS 分块头被截断`);
    const length = data.readUInt32BE(offset + 4);
    if (length < 8 || offset + length > data.length) fail(`${path} 的 ICNS 分块长度非法`);
    chunks.push(data.subarray(offset, offset + length));
    offset += length;
  }
  chunks.sort((left, right) => left.toString('ascii', 0, 4).localeCompare(right.toString('ascii', 0, 4)));
  const header = Buffer.alloc(8);
  header.write('icns', 0, 'ascii');
  header.writeUInt32BE(8 + chunks.reduce((total, chunk) => total + chunk.length, 0), 4);
  writeFileSync(path, Buffer.concat([header, ...chunks]));
}

export function expectedOutputs() {
  const outputs = [
    ...CORE_OUTPUTS.map(([, target]) => target),
    'src-tauri/icons/tray-template.png',
    'src/assets/brand/tokenledger-app-icon.png',
    'src/components/brand/tokenLedgerGeometry.ts',
    'public/tokenledger-icon.svg',
    'apps/android/app/src/main/java/com/jeidorf/tokenledger/mobile/TokenLedgerBrand.kt',
    'apps/android/app/src/main/res/values/icon_colors.xml',
    'apps/android/app/src/main/res/drawable/ic_launcher_foreground.xml',
    'apps/android/app/src/main/res/drawable/ic_launcher_monochrome.xml',
    'apps/android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml',
    'apps/android/app/src/main/res/mipmap-anydpi-v26/ic_launcher_round.xml',
    'apps/android/app/src/main/res/mipmap-anydpi-v33/ic_launcher.xml',
    'apps/android/app/src/main/res/mipmap-anydpi-v33/ic_launcher_round.xml',
  ];
  for (const [density] of DENSITIES) {
    outputs.push(`apps/android/app/src/main/res/mipmap-${density}/ic_launcher.png`);
    outputs.push(`apps/android/app/src/main/res/mipmap-${density}/ic_launcher_round.png`);
  }
  return outputs.sort();
}

function validateStage(stage, mark) {
  const pngDimensions = new Map([
    ['src-tauri/icons/32x32.png', [32, 32]],
    ['src-tauri/icons/128x128.png', [128, 128]],
    ['src-tauri/icons/128x128@2x.png', [256, 256]],
    ['src-tauri/icons/tray-template.png', [32, 32]],
    ['src/assets/brand/tokenledger-app-icon.png', [192, 192]],
  ]);
  for (const [density, size] of DENSITIES) {
    pngDimensions.set(`apps/android/app/src/main/res/mipmap-${density}/ic_launcher.png`, [size, size]);
    pngDimensions.set(`apps/android/app/src/main/res/mipmap-${density}/ic_launcher_round.png`, [size, size]);
  }
  for (const output of expectedOutputs()) {
    const path = join(stage, output);
    if (!existsSync(path) || !statSync(path).isFile() || statSync(path).size === 0) fail(`生成结果缺失或为空：${output}`);
  }
  for (const [output, expected] of pngDimensions) {
    const actual = readPngDimensions(join(stage, output));
    if (actual[0] !== expected[0] || actual[1] !== expected[1]) {
      fail(`${output} 尺寸错误：${actual.join('x')}，期望 ${expected.join('x')}`);
    }
  }
  validateBinary(join(stage, 'src-tauri/icons/icon.icns'), 'icns');
  validateBinary(join(stage, 'src-tauri/icons/icon.ico'), 'ico');
  const foreground = readFileSync(join(stage, 'apps/android/app/src/main/res/drawable/ic_launcher_foreground.xml'), 'utf8');
  const translateX = formatNumber(54 - mark.centerX * ANDROID_FOREGROUND_SCALE);
  if (!foreground.includes('android:width="108dp"') || !foreground.includes(`android:translateX="${translateX}"`) || !foreground.includes(`android:scaleX="${ANDROID_FOREGROUND_SCALE}"`)) {
    fail('Android adaptive foreground 未锁定 108dp 画布与直径 66dp 的圆形安全区');
  }
  const monochrome = readFileSync(join(stage, 'apps/android/app/src/main/res/mipmap-anydpi-v33/ic_launcher.xml'), 'utf8');
  if (!monochrome.includes('<monochrome ')) fail('Android API 33 图标缺少 monochrome');
}

function buildStage(root, tauriCli, stage) {
  const sourcePath = join(root, SOURCE_REL);
  if (!existsSync(sourcePath)) fail(`缺少品牌源 SVG：${SOURCE_REL}`);
  const mark = parseMark(readFileSync(sourcePath, 'utf8'));

  const renderDir = join(stage, '.render');
  const appSource = join(renderDir, 'tokenledger-app.svg');
  const roundSource = join(renderDir, 'tokenledger-round.svg');
  const traySource = join(renderDir, 'tokenledger-tray.svg');
  const allIcons = join(renderDir, 'all');
  const brandPng = join(renderDir, 'brand');
  const trayPng = join(renderDir, 'tray');
  const androidLegacy = join(renderDir, 'android-legacy');
  const androidRound = join(renderDir, 'android-round');
  mkdirSync(renderDir, { recursive: true });
  writeFileSync(appSource, appIconSvg(mark));
  writeFileSync(roundSource, appIconSvg(mark, true));
  writeFileSync(traySource, traySvg(mark));

  runTauriIcon(tauriCli, ['--output', allIcons, appSource], root);
  normalizeIcns(join(allIcons, 'icon.icns'));
  runTauriIcon(tauriCli, ['--png', '192', '--output', brandPng, appSource], root);
  runTauriIcon(tauriCli, ['--png', '32', '--output', trayPng, traySource], root);
  const androidSizes = DENSITIES.flatMap(([, size]) => ['--png', String(size)]);
  runTauriIcon(tauriCli, [...androidSizes, '--output', androidLegacy, appSource], root);
  runTauriIcon(tauriCli, [...androidSizes, '--output', androidRound, roundSource], root);
  if (process.env.TOKENLEDGER_ICON_FAIL_AFTER_RENDER === '1') fail('按测试要求在渲染后中止');

  for (const [source, target] of CORE_OUTPUTS) copyStage(stage, join(allIcons, source), target);
  copyStage(stage, join(brandPng, '192x192.png'), 'src/assets/brand/tokenledger-app-icon.png');
  copyStage(stage, join(trayPng, '32x32.png'), 'src-tauri/icons/tray-template.png');
  for (const [density, size] of DENSITIES) {
    copyStage(stage, join(androidLegacy, `${size}x${size}.png`), `apps/android/app/src/main/res/mipmap-${density}/ic_launcher.png`);
    copyStage(stage, join(androidRound, `${size}x${size}.png`), `apps/android/app/src/main/res/mipmap-${density}/ic_launcher_round.png`);
  }

  writeStage(stage, 'src/components/brand/tokenLedgerGeometry.ts', typescriptGeometry(mark));
  writeStage(stage, 'apps/android/app/src/main/java/com/jeidorf/tokenledger/mobile/TokenLedgerBrand.kt', kotlinGeometry(mark));
  writeStage(stage, 'public/tokenledger-icon.svg', faviconSvg(mark));
  writeStage(stage, 'apps/android/app/src/main/res/values/icon_colors.xml', iconColors());
  writeStage(stage, 'apps/android/app/src/main/res/drawable/ic_launcher_foreground.xml', vectorDrawable(mark, '#FFFFFFFF'));
  writeStage(stage, 'apps/android/app/src/main/res/drawable/ic_launcher_monochrome.xml', vectorDrawable(mark, '#FFFFFFFF'));
  for (const file of ['ic_launcher.xml', 'ic_launcher_round.xml']) {
    writeStage(stage, `apps/android/app/src/main/res/mipmap-anydpi-v26/${file}`, adaptiveIcon(false));
    writeStage(stage, `apps/android/app/src/main/res/mipmap-anydpi-v33/${file}`, adaptiveIcon(true));
  }
  validateStage(stage, mark);
}

export function findDrift(stage, root) {
  const drift = [];
  for (const output of expectedOutputs()) {
    const generated = join(stage, output);
    const current = join(root, output);
    if (!existsSync(current) || !readFileSync(current).equals(readFileSync(generated))) drift.push(output);
  }
  return drift;
}

export function replaceOutputs(stage, root, options = {}) {
  const failAfterBackupAt = options.failAfterBackupAt ?? Number(process.env.TOKENLEDGER_ICON_FAIL_AFTER_BACKUP_AT ?? 0);
  const failAfterInstallAt = options.failAfterInstallAt ?? Number(process.env.TOKENLEDGER_ICON_FAIL_INSTALL_AT ?? 0);
  const transaction = mkdtempSync(join(dirname(root), '.tokenledger-icon-install-'));
  const backup = join(transaction, 'backup');
  const installed = [];
  let keepBackup = false;
  try {
    let count = 0;
    for (const output of expectedOutputs()) {
      const destination = join(root, output);
      const saved = join(backup, output);
      const item = { destination, saved, hadOriginal: false, installedNew: false };
      installed.push(item);
      mkdirSync(dirname(destination), { recursive: true });
      if (existsSync(destination)) {
        mkdirSync(dirname(saved), { recursive: true });
        renameSync(destination, saved);
        item.hadOriginal = true;
      }
      count += 1;
      if (failAfterBackupAt > 0 && count === failAfterBackupAt) fail(`按测试要求在备份第 ${count} 个旧文件后中止`);
      renameSync(join(stage, output), destination);
      item.installedNew = true;
      if (failAfterInstallAt > 0 && count === failAfterInstallAt) fail(`按测试要求在安装第 ${count} 个文件后中止`);
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const item of installed.reverse()) {
      try {
        if (item.installedNew) rmSync(item.destination, { force: true });
        if (item.hadOriginal) {
          mkdirSync(dirname(item.destination), { recursive: true });
          renameSync(item.saved, item.destination);
        }
      } catch (rollbackError) {
        rollbackErrors.push(`${item.destination}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
      }
    }
    if (rollbackErrors.length > 0) {
      keepBackup = true;
      throw new Error(`${error instanceof Error ? error.message : String(error)}；回滚未完整，备份保留在 ${backup}：${rollbackErrors.join('；')}`);
    }
    throw error;
  } finally {
    if (!keepBackup) rmSync(transaction, { recursive: true, force: true });
  }
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const root = options.root;
  const tauriCli = resolveTauriCli(root, options.tauriCli);
  const stage = mkdtempSync(join(dirname(root), '.tokenledger-icon-stage-'));
  try {
    buildStage(root, tauriCli, stage);
    if (options.check) {
      const drift = findDrift(stage, root);
      if (drift.length > 0) fail(`品牌资源已漂移，请运行生成命令：\n- ${drift.join('\n- ')}`);
      process.stdout.write('品牌资源与唯一 SVG 源一致。\n');
      return;
    }
    replaceOutputs(stage, root);
    process.stdout.write(`已从 ${relative(root, join(root, SOURCE_REL))} 生成 ${expectedOutputs().length} 个品牌资源。\n`);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`图标生成失败：${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
