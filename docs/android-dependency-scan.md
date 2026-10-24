# Android 依赖漏洞扫描（本机手动）

桌面端的 npm 与 cargo 依赖在 CI 里有锁文件可查，Android 这边还没有 Gradle 锁文件，云端也拿不到漏洞库，所以这一步需要在一台能上网、能正常构建 Android 的电脑上手动跑。做法是：临时让 Gradle 写出一份锁文件，交给 [OSV-Scanner](https://github.com/google/osv-scanner) 比对公开漏洞库，扫完删掉锁文件。仓库里的 Gradle 文件一个都不改。

建议在升级 `gradle/libs.versions.toml` 之后、发版之前各跑一次。

## 准备

1. 能正常构建 Android：JDK 17（不高于 21）、Android SDK Platform 36、`apps/android/local.properties` 里至少有 `sdk.dir`。不需要填 Supabase 配置。
2. 安装 OSV-Scanner 2.x，任选一种：
   - macOS：`brew install osv-scanner`
   - Windows / Linux：从 [Releases](https://github.com/google/osv-scanner/releases) 下载对应平台的单个可执行文件，放进 `PATH`。
   - 有 Go 环境：`go install github.com/google/osv-scanner/v2/cmd/osv-scanner@latest`
3. 确认版本：`osv-scanner --version`，应为 2.x。

## 第一步：写一个只在本机用的 init 脚本

在仓库外面新建一个文件，例如 `~/.config/tokenledger/lock-all.init.gradle.kts`（Windows 可放在 `%USERPROFILE%\.config\tokenledger\`），内容只有三行：

```kotlin
allprojects {
    dependencyLocking { lockAllConfigurations() }
}
```

它只在命令行用 `--init-script` 指定时生效，不影响平时的构建。

## 第二步：生成锁文件

在 `apps/android` 目录执行。下面以发布包实际打进 APK 的依赖（`releaseRuntimeClasspath`）为准：

macOS / Linux：

```bash
cd apps/android
./gradlew --no-daemon --init-script ~/.config/tokenledger/lock-all.init.gradle.kts \
  :app:dependencies --configuration releaseRuntimeClasspath --write-locks
```

Windows PowerShell：

```powershell
cd apps\android
.\gradlew.bat --no-daemon --init-script "$env:USERPROFILE\.config\tokenledger\lock-all.init.gradle.kts" `
  :app:dependencies --configuration releaseRuntimeClasspath --write-locks
```

成功后会出现 `apps/android/app/gradle.lockfile`，每行一个 `组:名:版本=配置名`。

想连调试包和单元测试依赖一起看，可以把 `--configuration releaseRuntimeClasspath` 换成多次执行 `debugRuntimeClasspath`、`debugUnitTestRuntimeClasspath`，结果会合并进同一个锁文件。

## 第三步：扫描

仍在 `apps/android` 目录：

```bash
osv-scanner scan source -L app/gradle.lockfile
```

- 退出码 0 表示没有已知漏洞；退出码 1 表示有，下面的表格列出包名、版本、漏洞编号与修复版本。
- 需要留档时加 `--format markdown --output-file osv-android.md`（输出文件放在仓库外，或扫完删除）。
- 网络受限时可以先在能联网的地方执行一次 `osv-scanner scan source --download-offline-databases -L app/gradle.lockfile`，之后用 `--offline-vulnerabilities` 离线比对。

## 第四步：清理

锁文件是 Gradle 锁这一类单写文件，不能顺手提交：

```bash
git -C ../.. status --short apps/android
rm app/gradle.lockfile            # Windows：Remove-Item app\gradle.lockfile
```

确认 `git status` 里不再有 `gradle.lockfile`。

## 有漏洞时怎么处理

1. 看漏洞是否落在实际会执行的路径上（例如只在测试依赖里的，风险低于打进 APK 的）。
2. 能升级的，在 `gradle/libs.versions.toml` 里升到修复版本；Compose BOM 会影响截图像素，升级它需要按 `apps/android/README.md` 重新生成截图基线。
3. 是传递依赖、上游还没发修复的，记下漏洞编号和理由，开一个任务 Issue 跟进。
4. 改依赖版本属于新增或变更依赖，按 `docs/COLLABORATION.md` 走 B 级评审。
5. 漏洞的利用细节不要写进公开 Issue 或 PR，只写包名、版本和漏洞编号。
