#!/usr/bin/env python3
"""兼容旧入口：转交给无第三方 Python 依赖的 Node 生成器。"""

from pathlib import Path
import shutil
import subprocess
import sys


def main() -> int:
    node = shutil.which("node")
    if node is None:
        print("图标生成失败：找不到 node", file=sys.stderr)
        return 1
    script = Path(__file__).with_name("generate-app-icons.mjs")
    completed = subprocess.run(
        [node, str(script), *sys.argv[1:]],
        check=False,
        timeout=300,
    )
    return completed.returncode


if __name__ == "__main__":
    raise SystemExit(main())
