#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
cat wechat-standalone-v4.1-secrets.tgz.b64.part* | base64 -d > wechat-standalone-v4.1-secrets.tgz
echo "Wrote wechat-standalone-v4.1-secrets.tgz ($(wc -c < wechat-standalone-v4.1-secrets.tgz) bytes)"
echo "Extract with: tar -xzf wechat-standalone-v4.1-secrets.tgz"
