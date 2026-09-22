#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
cat wechat_standalone_v3.mjs.b64.part* | base64 -d > wechat_standalone_v3.mjs
echo "Wrote wechat_standalone_v3.mjs ($(wc -c < wechat_standalone_v3.mjs) bytes)"
