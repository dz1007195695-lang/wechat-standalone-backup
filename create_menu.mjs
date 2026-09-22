// 创建公众号菜单脚本
// 用法: node create_menu.mjs

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configFile = path.join(__dirname, "wechat_mp_config.json");

if (!fs.existsSync(configFile)) {
  console.error("错误: 找不到 wechat_mp_config.json，请先在管理后台保存公众号配置");
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(configFile, "utf-8"));

if (!config.appId || !config.appSecret) {
  console.error("错误: AppID 或 AppSecret 未配置");
  process.exit(1);
}

// 获取 access_token
const tokenRes = await fetch(
  `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${config.appId}&secret=${config.appSecret}`
);
const tokenData = await tokenRes.json();

if (!tokenData.access_token) {
  console.error("获取 access_token 失败:", JSON.stringify(tokenData));
  process.exit(1);
}

console.log("access_token 获取成功");

// 创建菜单
const menu = {
  button: [
    {
      type: "click",
      name: "抄作业",
      key: config.menuKey || "BIND_QR"
    }
  ]
};

const createRes = await fetch(
  `https://api.weixin.qq.com/cgi-bin/menu/create?access_token=${tokenData.access_token}`,
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(menu)
  }
);
const result = await createRes.json();

if (result.errcode === 0) {
  console.log("✅ 菜单创建成功！");
  console.log("菜单名称: 抄作业");
  console.log("事件Key:", config.menuKey || "BIND_QR");
  console.log("请在手机微信上取消关注再重新关注公众号，或者等几分钟菜单生效");
} else {
  console.error("❌ 菜单创建失败:", JSON.stringify(result));
}
