#!/usr/bin/env bash
# CI 专用：安装桌面 E2E 需要的浏览器系统依赖与截图基线字体，限时并重试。
#
# runner 的 apt 镜像偶尔逐包缓慢，一卡就能把整个作业拖到超时。每次尝试都以 root
# 身份在独立进程组里跑，超时会连 apt-get/dpkg 一起结束，不会留下占着 dpkg 锁的
# 孤儿进程；重试前先等锁释放、把半装的包配置完，并换掉默认镜像。
# 已下载完的 .deb 留在 apt 缓存里，重试时不会重新下载。
set -uo pipefail

ATTEMPTS="${E2E_DEPS_ATTEMPTS:-3}"
DEPS_SECONDS="${E2E_DEPS_SECONDS:-420}"
FONTS_SECONDS="${E2E_FONTS_SECONDS:-180}"
BROWSERS=(chromium webkit)
# 截图基线依赖系统字体：样式的字体栈含 Inter，runner 默认没装就会回退到别的无衬线字体，
# 整页文字像素都变。这里装与生成基线的 Ubuntu 24.04 环境相同的字体集。
FONTS=(fonts-inter fonts-jetbrains-mono fonts-dejavu-core fonts-dejavu-mono fonts-liberation fonts-noto-color-emoji fonts-wqy-zenhei)
MIRRORS=/etc/apt/apt-mirrors.txt
LOCKS=(/var/lib/dpkg/lock-frontend /var/lib/dpkg/lock /var/cache/apt/archives/lock /var/lib/apt/lists/lock)

# 单次连接超时 30 秒、失败重试 5 次；拿锁最多等 60 秒，不再立刻失败。
printf '%s\n' 'Acquire::Retries "5";' 'Acquire::http::Timeout "30";' 'Acquire::https::Timeout "30";' 'DPkg::Lock::Timeout "60";' \
  | sudo tee /etc/apt/apt.conf.d/80-ci-retries >/dev/null

# 以 root 跑，让 apt-get 成为 timeout 进程组里的直接后代：sudo 会重置 PATH，所以把当前 PATH 带过去。
as_root_with_limit() {
  local seconds="$1"
  shift
  sudo env "PATH=$PATH" timeout --kill-after=20 "$seconds" "$@"
}

install_once() {
  as_root_with_limit "$DEPS_SECONDS" npx --no-install playwright install-deps "${BROWSERS[@]}" \
    && as_root_with_limit "$FONTS_SECONDS" apt-get install -y --no-install-recommends "${FONTS[@]}"
}

# 兜底：结束残留的 apt/dpkg，等锁释放（最多 60 秒），再把被打断的安装配置完。
recover_apt() {
  sudo pkill -KILL -x apt-get || true
  sudo pkill -KILL -f '^/usr/lib/apt/methods/' || true
  for _ in $(seq 30); do
    sudo fuser "${LOCKS[@]}" >/dev/null 2>&1 || break
    sleep 2
  done
  sudo dpkg --configure -a || true
}

# 镜像列表里还有别的源时去掉 azure 镜像（列表按 priority 选源，调顺序不管用），下一次 update 从别的源取。
drop_default_mirror() {
  [ -f "$MIRRORS" ] || return 0
  grep -q 'azure\.archive\.ubuntu\.com' "$MIRRORS" || return 0
  grep -qv 'azure\.archive\.ubuntu\.com' "$MIRRORS" || return 0
  sudo sed -i '/azure\.archive\.ubuntu\.com/d' "$MIRRORS"
  echo "已去掉默认 apt 镜像，改用："
  cat "$MIRRORS"
}

for attempt in $(seq "$ATTEMPTS"); do
  if install_once; then
    exit 0
  fi
  echo "::warning::系统依赖安装第 ${attempt} 次失败或超时"
  [ "$attempt" -lt "$ATTEMPTS" ] || break
  recover_apt
  drop_default_mirror
done
exit 1
