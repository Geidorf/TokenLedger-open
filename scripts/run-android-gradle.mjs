import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const androidRoot = path.join(repoRoot, 'apps', 'android');
const wrapper = path.join(androidRoot, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
const tasks = process.argv.slice(2);

if (tasks.length === 0) {
  console.error('Usage: node scripts/run-android-gradle.mjs <task> [...tasks]');
  process.exit(2);
}

/** Gradle 8.13 + AGP 支持到 JDK 21；再新的（本机 JAVA_HOME 指着 JDK 24）截图插件会直接拒绝。 */
const MAX_SUPPORTED_JDK = 21;

/** 读 `release` 文件里的 JAVA_VERSION，拿主版本号；读不到就返回 undefined（当作可用）。 */
function javaMajorVersion(home) {
  try {
    const release = fs.readFileSync(path.join(home, 'release'), 'utf8');
    const match = /^JAVA_VERSION="?(\d+)/mu.exec(release);
    return match ? Number(match[1]) : undefined;
  } catch {
    return undefined;
  }
}

function resolveJavaHome() {
  if (process.env.JAVA_HOME && fs.existsSync(process.env.JAVA_HOME)) {
    const major = javaMajorVersion(process.env.JAVA_HOME);
    if (major === undefined || major <= MAX_SUPPORTED_JDK) {
      return process.env.JAVA_HOME;
    }
    console.warn(
      `JAVA_HOME 指向 JDK ${major}，Gradle 8.13 与 AGP 只支持到 JDK ${MAX_SUPPORTED_JDK}` +
        `（截图插件会直接报错）。改用下面探测到的 JDK；要用别的请把 JAVA_HOME 指到 ≤ ${MAX_SUPPORTED_JDK} 的版本。`,
    );
  }
  const candidates = [
    '/opt/homebrew/opt/openjdk@17',
    '/opt/homebrew/opt/openjdk',
    '/usr/local/opt/openjdk@17',
    '/usr/local/opt/openjdk',
    // Windows 上系统默认的 java 可能是 JDK 24，Gradle 8.13 + AGP 只支持到 21；
    // Android Studio 自带的 JBR 版本正好。
    'C:/Program Files/Android/Android Studio/jbr',
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

const env = { ...process.env };
const javaHome = resolveJavaHome();
if (javaHome) {
  env.JAVA_HOME = javaHome;
}

// Windows 上 Gradle 全部失败的真正原因（2026-09-08 定位）：JDK 17+ 在 Windows 上给 Selector 建内部管道时
// 走 AF_UNIX，socket 文件默认放在 %TEMP%。本机的 %TEMP% 是 8.3 短名
// `C:\Users\<user>~1\AppData\Local\Temp`，AF_UNIX 的 connect 对它返回 EINVAL，于是
// `Selector.open()` 全局失败——Gradle 的任何 task 都起不来。此前几十个任务都把这条
// 记成「本机 Gradle 坏了，安卓门禁交 CI」，其实只要把 socket 目录换成一个普通短路径。
//
// 必须让**每个 fork 出来的 JVM** 都拿到：Gradle daemon 是另起进程，而且项目自己的
// gradle.properties 里的 org.gradle.jvmargs 会盖掉用户级设置。所以走 JAVA_TOOL_OPTIONS，
// 不走 GRADLE_OPTS，也不改仓库里的 gradle.properties。
if (process.platform === 'win32') {
  const socketDir = 'C:/jdktmp';
  // 目录必须真的存在，否则 AF_UNIX 照样连不上。
  fs.mkdirSync(socketDir, { recursive: true });
  const flag = `-Djdk.net.unixdomain.tmpdir=${socketDir}`;
  env.JAVA_TOOL_OPTIONS = env.JAVA_TOOL_OPTIONS ? `${env.JAVA_TOOL_OPTIONS} ${flag}` : flag;
}

const result = spawnSync(wrapper, ['--no-daemon', ...tasks], {
  cwd: androidRoot,
  env,
  // Windows cannot execute a .bat file directly through CreateProcess. Keep
  // Unix on direct exec, and let the system command interpreter launch only
  // the checked-in Gradle wrapper on Windows.
  shell: process.platform === 'win32',
  stdio: 'inherit',
  windowsHide: true,
});

if (result.error) {
  console.error(`Unable to start the Android Gradle wrapper: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
