#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
base64 -d wechat_standalone_v3.mjs.gz.b64 | gzip -dc > wechat_standalone_v3.mjs
echo "Decoded wechat_standalone_v3.mjs ($(wc -c < wechat_standalone_v3.mjs) bytes)"
