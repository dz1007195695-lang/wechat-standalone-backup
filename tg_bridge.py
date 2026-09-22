#!/usr/bin/env python3
"""Telegram MTProto 桥接（Telethon 真实用户号）。
监听论坛群话题消息，转给微信主程序；主程序通过本服务发文字/图片、建话题。
独立进程，避免和 Node 事件循环冲突。
"""
from __future__ import annotations
import asyncio
import base64
import io
import logging
import os
import time
from typing import Optional
import httpx
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from telethon import TelegramClient, events
from telethon.errors import FloodWaitError, SessionPasswordNeededError
from telethon.tl.functions.messages import CreateForumTopicRequest, EditForumTopicRequest
from telethon.tl.types import Message
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("tg-bridge")
API_ID = int(os.environ.get("TG_API_ID", "37811450"))
API_HASH = os.environ.get("TG_API_HASH", "0d2adcc804574e9ba306f92997e1bd5e")
PHONE = os.environ.get("TG_PHONE", "+971581498834")
SESSION = os.environ.get("TG_SESSION", "/root/tg_bridge")
DEFAULT_CHAT_ID = os.environ.get("TG_CHAT_ID", "3951386478")
WECHAT_INBOX = os.environ.get("WECHAT_INBOX", "http://127.0.0.1:9000/api/bridge/telegram_in")
BRIDGE_SECRET = os.environ.get("TG_BRIDGE_SECRET", "wechat-tg-bridge-2024")
HOST = os.environ.get("TG_BRIDGE_HOST", "127.0.0.1")
PORT = int(os.environ.get("TG_BRIDGE_PORT", "9002"))
client = TelegramClient(SESSION, API_ID, API_HASH)
app = FastAPI(title="tg-bridge")
_ready = {"ok": False, "me": None, "error": None}
def normalize_chat_id(raw) -> int:
    s = str(raw).strip()
    if not s:
        raise ValueError("empty chat id")
    n = int(s)
    if n > 0:
        return int("-100" + str(n))
    return n
def topic_id_from_message(msg: Message) -> Optional[int]:
    reply = getattr(msg, "reply_to", None)
    if reply is not None:
        top = getattr(reply, "reply_to_top_id", None)
        mid = getattr(reply, "reply_to_msg_id", None)
        return int(top or mid) if (top or mid) else None
    if getattr(msg, "forum_topic", False):
        return int(msg.id)
    return None
async def resolve_entity(chat_id):
    cid = normalize_chat_id(chat_id)
    try:
        return await client.get_entity(cid)
    except Exception:
        inner = abs(cid)
        if str(inner).startswith("100"):
            inner = int(str(inner)[3:])
        return await client.get_entity(inner)
class SendTextBody(BaseModel):
    chat_id: Optional[str] = None
    thread_id: Optional[int] = None
    text: str
    parse_mode: Optional[str] = None
class CreateTopicBody(BaseModel):
    chat_id: Optional[str] = None
    name: str
class CloseTopicBody(BaseModel):
    chat_id: Optional[str] = None
    thread_id: int
    closed: bool = True
async def flood_retry(coro_factory, tries=4):
    last = None
    for i in range(tries):
        try:
            return await coro_factory()
        except FloodWaitError as e:
            last = e
            wait = int(getattr(e, "seconds", 5)) + 1
            log.warning("FloodWait %ss, retry %s/%s", wait, i + 1, tries)
            await asyncio.sleep(wait)
    raise last or RuntimeError("flood retry exhausted")
@app.get("/health")
async def health():
    return {
        "ok": _ready["ok"],
        "me": _ready["me"],
        "error": _ready["error"],
        "chat_id": DEFAULT_CHAT_ID,
    }
@app.post("/send_text")
async def send_text(body: SendTextBody):
    if not _ready["ok"]:
        raise HTTPException(503, "telegram client not ready")
    chat_id = body.chat_id or DEFAULT_CHAT_ID
    entity = await resolve_entity(chat_id)
    kwargs = {"reply_to": int(body.thread_id)} if body.thread_id else {}
    msg = await flood_retry(lambda: client.send_message(entity, body.text, **kwargs))
    return {"ok": True, "id": msg.id, "thread_id": body.thread_id}
@app.post("/send_photo")
async def send_photo(
    chat_id: Optional[str] = Form(None),
    thread_id: Optional[int] = Form(None),
    caption: Optional[str] = Form(""),
    photo: UploadFile = File(...),
):
    if not _ready["ok"]:
        raise HTTPException(503, "telegram client not ready")
    raw = await photo.read()
    if not raw:
        raise HTTPException(400, "empty photo")
    entity = await resolve_entity(chat_id or DEFAULT_CHAT_ID)
    bio = io.BytesIO(raw)
    bio.name = photo.filename or "photo.jpg"
    kwargs = {"caption": caption or ""}
    if thread_id:
        kwargs["reply_to"] = int(thread_id)
    msg = await flood_retry(lambda: client.send_file(entity, bio, **kwargs))
    return {"ok": True, "id": msg.id, "thread_id": thread_id}
@app.post("/create_topic")
async def create_topic(body: CreateTopicBody):
    if not _ready["ok"]:
        raise HTTPException(503, "telegram client not ready")
    entity = await resolve_entity(body.chat_id or DEFAULT_CHAT_ID)
    title = (body.name or "未命名粉丝")[:128]
    if CreateForumTopicRequest is not None:
        result = await flood_retry(lambda: client(CreateForumTopicRequest(peer=entity, title=title)))
        topic_id = None
        for upd in getattr(result, "updates", []) or []:
            msg = getattr(upd, "message", None)
            if msg is not None and getattr(msg, "id", None):
                topic_id = msg.id
                break
        if topic_id is None and getattr(result, "id", None):
            topic_id = result.id
    else:
        # 旧版兼容：直接发一条消息作为话题首条
        msg = await flood_retry(lambda: client.send_message(entity, f"📂 新对话: {title}"))
        topic_id = msg.id
    log.info("created topic %s title=%s", topic_id, title)
    return {"ok": True, "message_thread_id": topic_id, "name": title}

@app.post("/delete_topic")
async def delete_topic(body: CloseTopicBody):
    if not _ready["ok"]:
        raise HTTPException(503, "telegram client not ready")
    entity = await resolve_entity(body.chat_id or DEFAULT_CHAT_ID)
    await flood_retry(lambda: client.delete_messages(entity, [int(body.thread_id)], revoke=True))
    return {"ok": True}
@app.post("/close_topic")
async def close_topic(body: CloseTopicBody):
    if not _ready["ok"]:
        raise HTTPException(503, "telegram client not ready")
    if EditForumTopicRequest is None:
        # 旧版兼容，直接发消息
        entity = await resolve_entity(body.chat_id or DEFAULT_CHAT_ID)
        await flood_retry(lambda: client.send_message(entity, "✅ 对话已结束", reply_to=int(body.thread_id)))
        return {"ok": True}
    entity = await resolve_entity(body.chat_id or DEFAULT_CHAT_ID)
    await flood_retry(
        lambda: client(
            EditForumTopicRequest(
                channel=entity,
                topic_id=int(body.thread_id),
                closed=body.closed,
            )
        )
    )
    return {"ok": True}
async def push_to_wechat(payload: dict):
    payload["secret"] = BRIDGE_SECRET
    payload["ts"] = int(time.time())
    try:
        async with httpx.AsyncClient(timeout=60) as s:
            r = await s.post(WECHAT_INBOX, json=payload)
            if r.status_code >= 300:
                log.error("wechat inbox HTTP %s %s", r.status_code, r.text[:300])
            else:
                log.info("wechat inbox ok thread=%s", payload.get("thread_id"))
    except Exception as e:
        log.error("wechat inbox failed: %s", e)
@client.on(events.NewMessage())
async def on_new_message(event):
    try:
        if event.out:
            return
        chat = await event.get_chat()
        chat_id = getattr(chat, "id", None)
        expected = normalize_chat_id(DEFAULT_CHAT_ID)
        raw_ids = {expected, abs(expected)}
        if str(abs(expected)).startswith("100"):
            raw_ids.add(int(str(abs(expected))[3:]))
        if chat_id not in raw_ids and normalize_chat_id(chat_id) not in raw_ids:
            return
        msg: Message = event.message
        thread_id = topic_id_from_message(msg)
        if not thread_id:
            return
        sender = await event.get_sender()
        from_name = ""
        if sender is not None:
            from_name = " ".join(
                filter(None, [getattr(sender, "first_name", None), getattr(sender, "last_name", None)])
            ) or (getattr(sender, "username", None) or "")
        text = msg.message or msg.raw_text or ""
        photo_b64 = None
        if msg.photo or (msg.document and str(getattr(msg.document, "mime_type", "")).startswith("image/")):
            data = await msg.download_media(file=bytes)
            if data:
                photo_b64 = base64.b64encode(data).decode("ascii")
        if not text and not photo_b64:
            return
        log.info("tg inbound thread=%s text=%s photo=%s", thread_id, (text or "")[:40], bool(photo_b64))
        await push_to_wechat(
            {
                "chat_id": str(expected),
                "thread_id": int(thread_id),
                "text": text,
                "photo_b64": photo_b64,
                "from_id": getattr(sender, "id", None),
                "from_name": from_name,
            }
        )
    except Exception as e:
        log.exception("on_new_message: %s", e)
async def start_telegram():
    if not API_HASH or not PHONE:
        _ready["error"] = "TG_API_HASH / TG_PHONE 未配置"
        log.error(_ready["error"])
        return
    try:
        await client.connect()
        if not await client.is_user_authorized():
            _ready["error"] = "session 未登录，请先前台运行 python3 /root/tg_login.py"
            log.error(_ready["error"])
            return
        me = await client.get_me()
        _ready["ok"] = True
        _ready["me"] = {
            "id": me.id,
            "username": me.username,
            "phone": me.phone,
        }
        log.info("Telethon ready as @%s id=%s", me.username, me.id)
        await client.run_until_disconnected()
    except SessionPasswordNeededError:
        _ready["error"] = "需要两步验证密码，请运行 tg_login.py"
        log.error(_ready["error"])
    except Exception as e:
        _ready["error"] = str(e)
        log.exception("telegram start failed")
@app.on_event("startup")
async def on_startup():
    asyncio.create_task(start_telegram())
if __name__ == "__main__":
    import uvicorn
    uvicorn.run("tg_bridge:app", host=HOST, port=PORT, reload=False)
