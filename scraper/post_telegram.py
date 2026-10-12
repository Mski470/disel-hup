#!/usr/bin/env python3
"""ينشر العروض الجديدة على قناة تيليجرام (بدون مكتبات خارجية).

المتغيرات المطلوبة (تتحط كـ Secrets في GitHub):
  TELEGRAM_BOT_TOKEN : توكن البوت من @BotFather
  TELEGRAM_CHAT_ID   : مثل @your_channel_username (والبوت لازم يكون Admin في القناة)
اختياري:
  TELEGRAM_MAX_POSTS : أقصى عدد رسائل في التشغيل الواحد (الافتراضي 5)

تجربة بدون إرسال:  python scraper/post_telegram.py --dry-run
"""
from __future__ import annotations

import argparse
import datetime as dt
import html
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from affiliate import build_affiliate_url  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
POSTED = ROOT / "data" / "posted.json"
STALE_HOURS = 36  # ما ننشرش عرض أقدم من كده
TYPE_ICON = {"deal": "🔥", "coupon": "🎟️", "free": "🎁"}
CUR = {"EGP": "ج.م", "SAR": "ر.س", "AED": "د.إ", "KWD": "د.ك", "MAD": "د.م", "USD": "$"}


def load(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default


def fmt(n) -> str:
    return f"{n:,.2f}".rstrip("0").rstrip(".")


def build_message(d: dict, pmap: dict, cfg: dict) -> str:
    plat = pmap[d["platform"]]
    esc = html.escape
    lines = [f"{TYPE_ICON.get(d['type'], '🔥')} <b>{esc(d['title'])}</b>", f"🏪 {esc(plat['name'])}"]
    if d.get("price"):
        cur = CUR.get(d.get("currency", ""), d.get("currency", ""))
        line = f"💰 <b>{fmt(d['price'])} {esc(cur)}</b>"
        if d.get("old_price"):
            off = round((1 - d["price"] / d["old_price"]) * 100)
            line += f" (كان {fmt(d['old_price'])}) — خصم {off}%"
        lines.append(line)
    if d.get("badge"):
        lines.append(f"✨ {esc(d['badge'])}")
    if d.get("coupon"):
        lines.append(f"🎟️ الكود: <code>{esc(d['coupon'])}</code>")
    link = build_affiliate_url(d["url"], d["platform"], cfg)
    lines.append(f"\n👉 <a href=\"{esc(link, quote=True)}\">افتح العرض</a>")
    site = (cfg.get("site_url") or "").rstrip("/")
    if site and "YOUR-SITE" not in site.upper():
        lines.append(f"🌐 المزيد من العروض: {esc(site)}")
    return "\n".join(lines)


def send(token: str, chat_id: str, text: str) -> None:
    body = json.dumps({"chat_id": chat_id, "text": text, "parse_mode": "HTML", "disable_web_page_preview": False}).encode()
    req = urllib.request.Request(f"https://api.telegram.org/bot{token}/sendMessage", data=body,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:  # noqa: S310
        r.read()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    token = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
    chat = os.environ.get("TELEGRAM_CHAT_ID", "").strip()
    if not args.dry_run and not (token and chat):
        print("تيليجرام غير مفعّل (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID غير موجودين) — تخطي.")
        return 0

    cfg = load(ROOT / "config.json", {})
    pmap = {p["id"]: p for p in load(ROOT / "platforms.json", {}).get("platforms", [])}
    data = load(ROOT / "data" / "deals.json", {"deals": []})
    posted = load(POSTED, [])
    limit = int(os.environ.get("TELEGRAM_MAX_POSTS", "5") or 5)
    now = dt.datetime.now(dt.timezone.utc)

    def fresh(d) -> bool:
        try:
            t = dt.datetime.strptime(d["added"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=dt.timezone.utc)
        except (KeyError, ValueError):
            return False
        return (now - t).total_seconds() < STALE_HOURS * 3600

    todo = [d for d in data.get("deals", [])
            if not d.get("demo") and d["id"] not in posted and d["platform"] in pmap and fresh(d)]
    todo.sort(key=lambda d: d["added"], reverse=True)

    sent = 0
    for d in todo[:limit]:
        msg = build_message(d, pmap, cfg)
        if args.dry_run:
            print(msg, "\n" + "-" * 40)
            continue
        try:
            send(token, chat, msg)
        except urllib.error.HTTPError as e:
            print(f"فشل إرسال {d['id']}: HTTP {e.code} {e.read().decode(errors='replace')[:200]}")
            continue
        except Exception as e:  # noqa: BLE001
            print(f"فشل إرسال {d['id']}: {e}")
            continue
        posted.append(d["id"])
        sent += 1
        time.sleep(3.2)  # حد تيليجرام للقنوات

    if not args.dry_run and sent:
        POSTED.write_text(json.dumps(posted[-2000:], ensure_ascii=False), encoding="utf-8")
    print(f"تم نشر {sent} عرض." if not args.dry_run else f"(تجريبي) {min(len(todo), limit)} رسالة جاهزة.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
