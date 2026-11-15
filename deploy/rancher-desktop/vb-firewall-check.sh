#!/bin/sh
# 只读结构自检；沿用同一份策略参数，不创建目录、规则或进程。
set -eu
HERE=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
exec sh "$HERE/vb-firewall.start" --check
