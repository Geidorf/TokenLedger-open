#!/usr/bin/env bash
# TokenLedger · 当前平台桌面包 + 配置化 Android Debug APK 本地构建。
# 不要求商业发布证书：macOS 使用仓库管理的本机自签名身份，Windows 产出未签名安装包。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RELEASE_DIR="$PROJECT_ROOT/release"

cd "$PROJECT_ROOT"

echo "======================================================================"
echo "步骤 1/4：执行构建前门禁（既有 Clippy 基线仅报告）"
echo "======================================================================"
if [[ -n "$(git status --porcelain --untracked-files=normal)" ]]; then
    echo "构建已停止：工作区存在未提交内容，无法绑定唯一来源提交。" >&2
    exit 1
fi
npm run version:check
npm run typecheck
npm run test:frontend
npm run build:web
node scripts/check-bundle-budget.mjs
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo test --manifest-path src-tauri/Cargo.toml -- --test-threads=1
# 主干现有严格 Clippy 基线单独治理；本地构建仍完整输出告警。
cargo clippy --manifest-path src-tauri/Cargo.toml
git diff --check

if [[ -n "$(git status --porcelain --untracked-files=normal)" ]]; then
    echo "构建已停止：门禁修改了工作区。" >&2
    exit 1
fi

VERSION_NAME="$(node -e 'console.log(JSON.parse(require("fs").readFileSync("package.json")).version)')"
SOURCE_COMMIT="$(git rev-parse HEAD)"
BUILD_STARTED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
BUILD_ID="${BUILD_STARTED_AT//[-:]/}"
RUN_DIR="$RELEASE_DIR/local-builds/$BUILD_ID"
BUILD_MARKER="$(mktemp "${TMPDIR:-/tmp}/tokenledger-build.XXXXXX")"
trap 'rm -f "$BUILD_MARKER"' EXIT
mkdir -p "$RUN_DIR"
INCOMPLETE_MARKER="$RUN_DIR/INCOMPLETE.txt"
printf 'Build did not complete. Do not use these artifacts as release evidence.\n' > "$INCOMPLETE_MARKER"

ARTIFACTS=()
shopt -s nullglob

copy_current_artifacts() {
    local copied=0
    local source destination
    for source in "$@"; do
        if [[ -f "$source" && "$source" -nt "$BUILD_MARKER" ]]; then
            destination="$RUN_DIR/$(basename "$source")"
            cp "$source" "$destination"
            ARTIFACTS+=("$destination")
            copied=$((copied + 1))
        fi
    done
    [[ "$copied" -gt 0 ]]
}

echo ""
echo "======================================================================"
echo "步骤 2/4：构建当前平台桌面产物"
echo "======================================================================"

UNAME_OUT="$(uname -s)"
case "$UNAME_OUT" in
    Darwin*)
        echo "检测到 macOS：构建本机自签名 Debug App 与 DMG 安装包并归档。"
        bash "$SCRIPT_DIR/build-macos-local-signed.sh"
        MAC_APP="$PROJECT_ROOT/src-tauri/target/debug/bundle/macos/tokenledger.app"
        if [[ ! -d "$MAC_APP" ]]; then
            echo "未找到本轮 macOS App：$MAC_APP" >&2
            exit 1
        fi
        MAC_ZIP="$RUN_DIR/TokenLedger_macOS_${VERSION_NAME}_local-debug.zip"
        ditto -c -k --sequesterRsrc --keepParent "$MAC_APP" "$MAC_ZIP"
        ARTIFACTS+=("$MAC_ZIP")

        MAC_DMG_SRC="$(find "$PROJECT_ROOT/src-tauri/target/debug/bundle/dmg" -name "*.dmg" 2>/dev/null | head -n 1)"
        if [[ -n "$MAC_DMG_SRC" && -f "$MAC_DMG_SRC" ]]; then
            MAC_DMG="$RUN_DIR/TokenLedger_macOS_${VERSION_NAME}_local-debug.dmg"
            cp "$MAC_DMG_SRC" "$MAC_DMG"
            cp "$MAC_DMG_SRC" "$RELEASE_DIR/TokenLedger_macOS_${VERSION_NAME}_local-debug.dmg"
            ARTIFACTS+=("$MAC_DMG")
        fi
        ;;
    Linux*)
        echo "检测到 Linux：构建 Tauri release bundle。"
        npm run build
        if ! copy_current_artifacts \
            "$PROJECT_ROOT"/src-tauri/target/release/bundle/appimage/*.AppImage \
            "$PROJECT_ROOT"/src-tauri/target/release/bundle/deb/*.deb \
            "$PROJECT_ROOT"/src-tauri/target/release/bundle/rpm/*.rpm; then
            echo "本轮 Linux 构建没有产生可归档 bundle。" >&2
            exit 1
        fi
        ;;
    MINGW*|MSYS*|CYGWIN*)
        echo "检测到 Windows：构建未签名 MSI/EXE。"
        npm run build
        if ! copy_current_artifacts \
            "$PROJECT_ROOT"/src-tauri/target/release/bundle/msi/*.msi \
            "$PROJECT_ROOT"/src-tauri/target/release/bundle/nsis/*.exe; then
            echo "本轮 Windows 构建没有产生可归档 MSI/EXE。" >&2
            exit 1
        fi
        ;;
    *)
        echo "不支持的构建环境：$UNAME_OUT" >&2
        exit 1
        ;;
esac

echo ""
echo "======================================================================"
echo "步骤 3/4：构建经过公开 Supabase 配置校验的 Android Debug APK"
echo "======================================================================"
ANDROID_APK="$RELEASE_DIR/TokenLedger_Android_${VERSION_NAME}_debug.apk"
# Gradle may otherwise keep the versioned Copy task UP-TO-DATE and leave a
# previous run's timestamp in place. Remove only this exact generated output.
rm -f -- "$ANDROID_APK"
node "$SCRIPT_DIR/run-android-gradle.mjs" :app:packageConfiguredDebug

if [[ ! -f "$ANDROID_APK" || ! "$ANDROID_APK" -nt "$BUILD_MARKER" ]]; then
    echo "本轮 Android 构建没有产生通过配置门禁的 APK：$ANDROID_APK" >&2
    exit 1
fi
ANDROID_ARCHIVE="$RUN_DIR/$(basename "$ANDROID_APK")"
cp "$ANDROID_APK" "$ANDROID_ARCHIVE"
ARTIFACTS+=("$ANDROID_ARCHIVE")

echo ""
echo "======================================================================"
echo "步骤 4/4：生成仅包含本轮产物的来源与 SHA-256 清单"
echo "======================================================================"

MANIFEST="$RUN_DIR/SHA256SUMS.txt"
{
    echo "buildStartedAt=$BUILD_STARTED_AT"
    echo "sourceCommit=$SOURCE_COMMIT"
    echo "version=$VERSION_NAME"
    echo "platform=$UNAME_OUT"
} > "$MANIFEST"

for artifact in "${ARTIFACTS[@]}"; do
    if command -v shasum >/dev/null 2>&1; then
        SHA256="$(shasum -a 256 "$artifact" | awk '{print $1}')"
    elif command -v sha256sum >/dev/null 2>&1; then
        SHA256="$(sha256sum "$artifact" | awk '{print $1}')"
    else
        echo "找不到 SHA-256 工具（shasum/sha256sum）。" >&2
        exit 1
    fi
    SIZE="$(du -h "$artifact" | awk '{print $1}')"
    FILE_NAME="$(basename "$artifact")"
    printf '%s  %s\n' "$SHA256" "$FILE_NAME" >> "$MANIFEST"
    echo "• $FILE_NAME ($SIZE)"
    echo "  SHA-256: $SHA256"
done

rm -f -- "$INCOMPLETE_MARKER"
echo "构建时间：$BUILD_STARTED_AT"
echo "来源提交：$SOURCE_COMMIT"
echo "本轮归档：$RUN_DIR"
echo "清单文件：$MANIFEST"
echo "======================================================================"
echo "本地构建与证据归档完成。"
echo "======================================================================"
