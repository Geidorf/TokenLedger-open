#!/usr/bin/env bash
# 在 CI 上为 scripts/run-supabase-release-gate.mjs 准备它要求的隔离环境并启动服务。
#
# 门禁拒绝直接对仓库里的 supabase/ 动手：它要求一个 checkout 之外的绝对工作目录、
# 专用的 tokenledger-t*-sql-* 项目名、避开 54320-54329 默认段的端口，以及数据库
# 容器的完整 64 位 ID。这里把 config.toml 与 migrations 复制到该目录，改项目名、
# 把 543xx 端口整体平移到 553xx，然后 `supabase start --workdir`。
#
# 用法：scripts/start-supabase-gate-isolation.sh <workdir> <project>
# 三个 TOKENLEDGER_SUPABASE_GATE_* 变量写入 $GITHUB_ENV（未设置时打印到 stdout）。
set -euo pipefail

WORKDIR="${1:?usage: $0 <absolute workdir> <project>}"
PROJECT="${2:?usage: $0 <absolute workdir> <project>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

case "$WORKDIR" in
  /*) ;;
  *) echo "workdir must be absolute: $WORKDIR" >&2; exit 1 ;;
esac

mkdir -p "$WORKDIR/supabase"
cp -R "$ROOT/supabase/migrations" "$WORKDIR/supabase/migrations"
sed -E \
  -e "s/^project_id = \"[^\"]*\"/project_id = \"$PROJECT\"/" \
  -e 's/^([[:space:]]*(port|shadow_port)[[:space:]]*=[[:space:]]*)543([0-9]{2})[[:space:]]*$/\1553\3/' \
  "$ROOT/supabase/config.toml" > "$WORKDIR/supabase/config.toml"

if grep -nE '^[[:space:]]*(port|shadow_port)[[:space:]]*=[[:space:]]*5432[0-9]' "$WORKDIR/supabase/config.toml"; then
  echo "default Supabase ports are still present after remapping" >&2
  exit 1
fi

# 门禁只接受 public.ecr.aws / docker.io 的 supabase/postgres 镜像；CLI 在 GitHub Actions 上
# 会不定期改从 ghcr.io 拉镜像，导致容器身份核对时好时坏。这里钉住镜像源。
export SUPABASE_INTERNAL_IMAGE_REGISTRY="${SUPABASE_INTERNAL_IMAGE_REGISTRY:-public.ecr.aws}"

supabase start --workdir "$WORKDIR"

CONTAINER="$(docker inspect --format '{{.Id}}' "supabase_db_$PROJECT")"
# 门禁会逐项核对名称、镜像、标签、端口与数据卷；先把这些字段打出来，失败时能直接对照。
docker inspect --format 'name={{.Name}} image={{.Config.Image}} running={{.State.Running}} labels={{json .Config.Labels}} ports={{json .HostConfig.PortBindings}} mounts={{json .Mounts}}' "$CONTAINER"
OUT="${GITHUB_ENV:-/dev/stdout}"
{
  echo "TOKENLEDGER_SUPABASE_GATE_WORKDIR=$WORKDIR"
  echo "TOKENLEDGER_SUPABASE_GATE_PROJECT=$PROJECT"
  echo "TOKENLEDGER_SUPABASE_GATE_CONTAINER=$CONTAINER"
  echo "SUPABASE_INTERNAL_IMAGE_REGISTRY=$SUPABASE_INTERNAL_IMAGE_REGISTRY"
} >> "$OUT"
