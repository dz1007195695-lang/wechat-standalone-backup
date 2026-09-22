# wechat-standalone 4.1版（全量含密钥备份）

- 时间：2026-09-23（Asia/Shanghai）
- 来源：ECS20260911898680
- 说明：私人仓库备份，**含** ipoasis.env、tg_bridge.env、公众号配置、TG session、openclaw-weixin 账号会话等密钥。
- 用途：回滚 / 私有存档。请勿公开、勿随意加人协作。

## 文件

- `v4.1/VERSION.txt` — 版本说明
- `v4.1/FILE_LIST.txt` — 文件清单
- `v4.1/wechat-standalone-v4.1-secrets.tgz.b64.part00` … — 全量包 base64 分片
- 合并还原：

```bash
cat v4.1/wechat-standalone-v4.1-secrets.tgz.b64.part* | base64 -d > wechat-standalone-v4.1-secrets.tgz
tar -xzf wechat-standalone-v4.1-secrets.tgz
```

## 备注

4.1版
