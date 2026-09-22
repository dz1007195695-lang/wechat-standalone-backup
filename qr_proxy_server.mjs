import http from "http";
import { HttpsProxyAgent } from "https-proxy-agent";
import axios from "axios";
import QRCode from "qrcode";
import fs from "fs";
import Jimp from "jimp";
import crypto from "crypto";

const QR_API_BASE = "https://ilinkai.weixin.qq.com";
const QR_POOL = [];
const POOL_SIZE = 10;
const QR_MAX_AGE_MS = 60 * 1000; // 超过1分钟废弃（不变）
const FILL_CONCURRENCY = 5; // 并行补码，不拉长TTL
const MP_CFG = JSON.parse(fs.readFileSync("/root/wechat_mp_config.json", "utf-8"));
console.log("公众号appid:", MP_CFG.appId);

function getFixedProxy(sessionKey) {
  const safe = String(sessionKey).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 48) || crypto.randomBytes(8).toString("hex");
  // sticky session IP: same sessionKey => same egress IP for generate + poll
  return new HttpsProxyAgent(
    `http://user-uMK8KThb_7334-region-cn-sessionid-${safe}:7fj94J6b@gate-as.ipoasis.com:8668`
  );
}

async function proxyRequest(sessionKey, url, { method = "GET", headers = {}, body } = {}) {
  const agent = getFixedProxy(sessionKey);
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await axios({
        url,
        method,
        headers,
        data: body,
        httpsAgent: agent,
        proxy: false,
        timeout: 25000,
        validateStatus: () => true,
        responseType: "text",
        transformResponse: [(d) => d],
      });
      const raw = res.data;
      if (raw === "" || raw == null) {
        lastErr = new Error(`empty body status=${res.status} attempt=${attempt}`);
        await new Promise(r => setTimeout(r, 800 * attempt));
        continue;
      }
      let data = raw;
      if (typeof raw === "string") {
        try { data = JSON.parse(raw); } catch (e) {
          lastErr = new Error(`bad json status=${res.status}: ${String(raw).slice(0,120)}`);
          await new Promise(r => setTimeout(r, 800 * attempt));
          continue;
        }
      }
      return { status: res.status, data };
    } catch (e) {
      lastErr = e;
      await new Promise(r => setTimeout(r, 800 * attempt));
    }
  }
  throw lastErr || new Error("proxyRequest failed");
}

let mpToken = { token: "", expiresAt: 0 };
async function getMpAccessToken() {
  if (mpToken.token && Date.now() < mpToken.expiresAt - 60000) return mpToken.token;
  const res = await fetch(
    `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${MP_CFG.appId}&secret=${MP_CFG.appSecret}`
  );
  const data = await res.json();
  if (!data.access_token) throw new Error("get token failed: " + JSON.stringify(data));
  mpToken = { token: data.access_token, expiresAt: Date.now() + (data.expires_in || 7200) * 1000 };
  return mpToken.token;
}

async function uploadMpMedia(imageBuffer) {
  async function once(forceRefresh) {
    if (forceRefresh) mpToken = { token: "", expiresAt: 0 };
    const token = await getMpAccessToken();
    const boundary = "----WeChatFormBoundary" + crypto.randomBytes(8).toString("hex");
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="media"; filename="qr.png"\r\nContent-Type: image/png\r\n\r\n`),
      imageBuffer,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const res = await fetch(`https://api.weixin.qq.com/cgi-bin/media/upload?access_token=${token}&type=image`, {
      method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
      body,
    });
    return await res.json();
  }
  let data = await once(false);
  if (data.errcode === 40001 || data.errcode === 42001) {
    console.log("access_token失效，强制刷新后重试上传");
    data = await once(true);
  }
  if (!data.media_id) throw new Error("上传素材失败: " + JSON.stringify(data));
  return data.media_id;
}

async function composeQrImage(qrImageBuffer) {
  const templateFile = "/root/qr_template.png";
  const [template, qrImg] = await Promise.all([Jimp.read(templateFile), Jimp.read(qrImageBuffer)]);
  const size = 265;
  const padding = 20;
  const totalSize = size + padding * 2;
  qrImg.resize(size, size);
  const whiteBg = new Jimp(totalSize, totalSize, 0xffffffff);
  whiteBg.composite(qrImg, padding, padding);
  template.composite(whiteBg, 135, 545);
  return await template.getBufferAsync(Jimp.MIME_PNG);
}

async function generateOne() {
  const sessionKey = crypto.randomUUID();
  const { data: qrResp } = await proxyRequest(
    sessionKey,
    `${QR_API_BASE}/ilink/bot/get_bot_qrcode?bot_type=3`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "iLink-App-Id": "bot",
        "iLink-App-ClientVersion": "2.4.8",
      },
      body: { local_token_list: [] },
    }
  );
  if (!qrResp || qrResp.ret !== 0 || !qrResp.qrcode) {
    throw new Error("生成失败: " + JSON.stringify(qrResp).slice(0, 200));
  }
  const rawQr = qrResp.qrcode_img_content || qrResp.qrcode;
  const qrBuffer = await QRCode.toBuffer(rawQr, { width: 260, margin: 0 });
  const composedBuffer = await composeQrImage(qrBuffer);
  const mediaId = await uploadMpMedia(composedBuffer);
  console.log("预生成并上传素材成功:", qrResp.qrcode, "mediaId:", mediaId, "session:", sessionKey);
  return {
    sessionKey,
    qrcode: qrResp.qrcode,
    qrcode_img_content: qrResp.qrcode_img_content,
    mediaId,
    createdAt: Date.now(),
  };
}

let refreshing = false;
function purgeStalePool() {
  const now = Date.now();
  let discarded = 0;
  for (let i = QR_POOL.length - 1; i >= 0; i--) {
    if (now - QR_POOL[i].createdAt > QR_MAX_AGE_MS) {
      QR_POOL.splice(i, 1);
      discarded++;
    }
  }
  if (discarded) console.log("废弃超时码:", discarded, "剩余:", QR_POOL.length);
  return discarded;
}

async function refreshPool() {
  if (refreshing) return;
  refreshing = true;
  try {
    purgeStalePool();
    let failStreak = 0;
    while (QR_POOL.length < POOL_SIZE && failStreak < 3) {
      const need = Math.min(FILL_CONCURRENCY, POOL_SIZE - QR_POOL.length);
      const results = await Promise.allSettled(
        Array.from({ length: need }, () => generateOne())
      );
      let ok = 0;
      for (const r of results) {
        if (r.status === "fulfilled") {
          QR_POOL.push(r.value);
          ok++;
        } else {
          console.log("预生成失败:", r.reason?.message || r.reason);
        }
      }
      if (ok === 0) {
        failStreak++;
        await new Promise((r) => setTimeout(r, 1500 * failStreak));
      } else {
        failStreak = 0;
        console.log("并行补码成功", ok, "池子当前数量:", QR_POOL.length);
      }
      purgeStalePool();
    }
  } finally {
    refreshing = false;
  }
}
refreshPool();
setInterval(refreshPool, 10000);

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = (req.url || "").split("?")[0];
  try {
    if (url === "/get_qr") {
      let qr = null;
      while (QR_POOL.length) {
        const candidate = QR_POOL.shift();
        if (Date.now() - candidate.createdAt > QR_MAX_AGE_MS) {
          console.log("取码时废弃超时码:", candidate.qrcode, "ageMs=", Date.now() - candidate.createdAt);
          continue;
        }
        qr = candidate;
        break;
      }
      if (!qr) {
        // 空池时当场现生成，保持1分钟TTL不变
        try {
          qr = await generateOne();
          console.log("空池现生成成功:", qr.qrcode);
        } catch (e) {
          console.log("空池现生成失败:", e.message);
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "池子空了", detail: e.message }));
          refreshPool().catch(() => {});
          return;
        }
      }
      refreshPool().catch(() => {});
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        sessionKey: qr.sessionKey,
        qrcode: qr.qrcode,
        qrcode_img_content: qr.qrcode_img_content,
        mediaId: qr.mediaId,
        createdAt: qr.createdAt,
      }));
      console.log("主程序拿了预上传的码:", qr.qrcode, "当前池子:", QR_POOL.length);
      return;
    }
    if (url === "/poll_qr" || url === "/poll_qr_status") {
      const raw = await readBody(req);
      const { qrcode, sessionKey, redirectHost, verifyCode } = JSON.parse(raw || "{}");
      if (!qrcode || !sessionKey) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "missing qrcode/sessionKey" }));
        return;
      }
      const base = redirectHost ? `https://${String(redirectHost).replace(/^https?:\/\//, "")}` : QR_API_BASE;
      let endpoint = `${base}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
      if (verifyCode) endpoint += `&verify_code=${encodeURIComponent(verifyCode)}`;
      const { data } = await proxyRequest(sessionKey, endpoint, {
        method: "GET",
        headers: { "iLink-App-Id": "bot", "iLink-App-ClientVersion": "2.4.8" },
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
      return;
    }
    if (url === "/pool_status" || url === "/status" || url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, poolSize: QR_POOL.length, count: QR_POOL.length }));
      return;
    }
    res.writeHead(404);
    res.end();
  } catch (e) {
    console.error("request error:", e.message);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: e.message }));
  }
});

server.listen(9003, () => {
  console.log("二维码代理服务启动在9003 (IPOasis sticky + axios)");
});
