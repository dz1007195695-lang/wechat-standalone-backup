# wechat-standalone-backup（私有回滚备份）

备份时间：2026-09-22 18:18（Asia/Shanghai）  
来源：ECS20260911898680（`191.124.123.178`）上当时正在 PM2 运行的程序。

## 包含的进程与入口

| PM2 名 | 文件 | 端口 |
|--------|------|------|
| wechat-standalone | `wechat_standalone_v3.mjs` | 9000 |
| qr-proxy | `qr_proxy_server.mjs` | 9003 |
| tg-bridge | `tg_bridge.py` | 9002 |

另含：`package.json`、`requirements-tg-bridge.txt`、`create_menu.mjs`、`qr_template.png`、`pm2/ecosystem-processes.json`。

## 配置文件

- `wechat_mp_config.json`、`tg_bridge.env`、`qr_config.json`：当时运行配置（私有库内保留，便于完整回滚）
- `config-examples/`：脱敏示例，可对外参考

## 未纳入（体积大 / 敏感会话）

- `/root/wechat-accounts/`（各 bot_token、context_token）
- `tg_bridge.session*`
- `wechat_data.json` 运行时业务数据

回滚程序代码后，账号凭证仍需从服务器原目录保留或另行备份。

## 回滚步骤（服务器上）

```bash
# 1. 备份当前文件（可选）
cp -a /root/wechat_standalone_v3.mjs /root/wechat_standalone_v3.mjs.bak.$(date +%s)

# 2. 用仓库文件覆盖
# 假设已 clone 到 /root/wechat-standalone-backup
cp -a wechat_standalone_v3.mjs qr_proxy_server.mjs tg_bridge.py /root/
cp -a package.json create_menu.mjs qr_template.png /root/
cp -a wechat_mp_config.json qr_config.json /root/
cp -a tg_bridge.env /root/

# 3. 依赖（如需要）
cd /root && npm install
pip3 install -r requirements-tg-bridge.txt

# 4. 重启
pm2 restart wechat-standalone qr-proxy tg-bridge
```

## 安全提醒

本仓库为 **private**。`qr_proxy_server.mjs` 与配置文件可能含代理/公众号/Telegram 密钥，请勿改为公开或分享。
