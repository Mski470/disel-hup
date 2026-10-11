#!/usr/bin/env python3
"""جامع العروض: يقرأ المصادر المعرّفة في scraper/sources.json ويكتب data/deals.json.

لا يحتاج أي مكتبات خارجية (Python 3.9+ فقط).

أنواع المصادر المدعومة:
  csv  : جدول (Google Sheet منشور كـ CSV، أو ملف منتجات/كوبونات من شبكة أفلييت)
  json : واجهة JSON (API) مع تحديد مسار القائمة وربط الحقول
  rss  : تغذية RSS/Atom

تشغيل تجريبي:  python scraper/fetch_deals.py --dry-run
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import hashlib
import io
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

ROOT = Path(__file__).resolve().parent.parent
UA = "Mozilla/5.0 (compatible; DealsHubBot/1.0)"
MAX_DEALS = 600
TYPES = {
    "deal": "deal", "discount": "deal", "sale": "deal", "خصم": "deal", "عرض": "deal", "تخفيض": "deal",
    "coupon": "coupon", "code": "coupon", "voucher": "coupon", "كوبون": "coupon", "كود": "coupon",
    "free": "free", "freebie": "free", "مجاني": "free", "مجانا": "free", "مجانًا": "free",
}
CURRENCY_BY_COUNTRY = {"EG": "EGP", "SA": "SAR", "AE": "AED", "KW": "KWD", "MA": "MAD"}
AR_DIGITS = str.maketrans("٠١٢٣٤٥٦٧٨٩٫٬", "0123456789.,")
TRACKING = re.compile(r"^(utm_|fbclid$|gclid$|igshid$|ref$|ref_$|tag$|aff|affid$|subid)", re.I)


def log(*a):
    print(*a, file=sys.stderr)


# ---------------------------------------------------------------- أدوات
def load_json(path: Path, default=None):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default


def http_get(url: str, timeout: int = 30, retries: int = 2) -> bytes:
    last = None
    for i in range(retries + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*"})
            with urllib.request.urlopen(req, timeout=timeout) as r:  # noqa: S310 - المصدر يحدده صاحب الموقع
                return r.read()
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            last = e
            time.sleep(1.5 * (i + 1))
    raise RuntimeError(f"تعذّر تحميل {url}: {last}")


def to_number(v):
    """يحوّل '1,299.50 ج.م' أو '١٢٩٩' إلى رقم. يرجع None لو مش رقم."""
    if v is None or v == "":
        return None
    if isinstance(v, (int, float)):
        return float(v) if v > 0 else None
    s = str(v).translate(AR_DIGITS)
    s = re.sub(r"[^\d.,]", "", s)
    if not s:
        return None
    if "," in s and "." in s:
        s = s.replace(",", "")
    elif "," in s:
        # 1,299 (آلاف)  أو  12,5 (عشري)
        s = s.replace(",", "") if re.search(r",\d{3}(?!\d)", s) else s.replace(",", ".")
    try:
        n = float(s)
    except ValueError:
        return None
    return n if n > 0 else None


def parse_date(v):
    """يقبل ISO أو YYYY-MM-DD أو DD/MM/YYYY أو تاريخ RSS. يرجع ISO بتوقيت UTC أو None."""
    if not v:
        return None
    s = str(v).strip().translate(AR_DIGITS)
    fmts = ("%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%dT%H:%M:%S%z", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d", "%d/%m/%Y", "%d-%m-%Y",
            "%a, %d %b %Y %H:%M:%S %z", "%a, %d %b %Y %H:%M:%S %Z")
    for f in fmts:
        try:
            d = dt.datetime.strptime(s, f)
        except ValueError:
            continue
        if f in ("%Y-%m-%d", "%d/%m/%Y", "%d-%m-%Y"):
            d = d.replace(hour=23, minute=59, second=59)  # تاريخ بدون وقت = ينتهي آخر اليوم
        if d.tzinfo is None:
            d = d.replace(tzinfo=dt.timezone.utc)
        return d.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return None


def http_url(v) -> str:
    try:
        p = urlsplit(str(v).strip())
        return p.geturl() if p.scheme in ("http", "https") and p.netloc else ""
    except ValueError:
        return ""


def canonical(url: str) -> str:
    p = urlsplit(url)
    q = [(k, v) for k, v in parse_qsl(p.query, keep_blank_values=True) if not TRACKING.match(k)]
    return urlunsplit((p.scheme, p.netloc.lower(), p.path.rstrip("/") or "/", urlencode(q), ""))


def clean_url(url: str) -> str:
    """يشيل باراميترات التتبّع وأي tag/أفلييت تابع لغيرك من الرابط قبل التخزين."""
    p = urlsplit(url)
    q = [(k, v) for k, v in parse_qsl(p.query, keep_blank_values=True) if not TRACKING.match(k)]
    return urlunsplit((p.scheme, p.netloc, p.path, urlencode(q), ""))


def get_path(obj, path: str):
    for part in (path or "").split("."):
        if part == "":
            continue
        if isinstance(obj, list) and part.isdigit():
            obj = obj[int(part)] if int(part) < len(obj) else None
        elif isinstance(obj, dict):
            obj = obj.get(part)
        else:
            return None
    return obj


# ---------------------------------------------------------------- المنصات
def infer_platform(url: str, platforms: list):
    p = urlsplit(url)
    host = p.netloc.lower().split(":")[0]
    cands = [x for x in platforms if host == x["domain"] or host.endswith("." + x["domain"])]
    if not cands:
        return None
    if len(cands) > 1:  # مثل noon.com: نفرّق بالمسار /egypt-ar/ ...
        for c in cands:
            hp = urlsplit(c["home"]).path
            if hp not in ("", "/") and p.path.startswith(hp):
                return c["id"]
    return cands[0]["id"]


# ---------------------------------------------------------------- التطبيع
def normalize(raw: dict, defaults: dict, pmap: dict, platforms: list, cats: set, prev_added: dict, now_iso: str):
    r = {k: (v.strip() if isinstance(v, str) else v) for k, v in raw.items()}
    for k, v in defaults.items():
        if not r.get(k):
            r[k] = v

    title = re.sub(r"\s+", " ", str(r.get("title") or "")).strip()[:160]
    url = http_url(r.get("url"))
    url = clean_url(url) if url else url
    if not title or not url:
        return None, "بدون عنوان أو رابط صالح"

    pid = r.get("platform") if r.get("platform") in pmap else infer_platform(url, platforms)
    if not pid:
        return None, f"منصة غير معروفة للرابط {url}"
    plat = pmap[pid]

    coupon = re.sub(r"\s+", "", str(r.get("coupon") or ""))[:40]
    typ = TYPES.get(str(r.get("type") or "").lower().strip()) or ("coupon" if coupon else "deal")
    if typ == "coupon" and not coupon:
        typ = "deal"

    price, old = to_number(r.get("price")), to_number(r.get("old_price"))
    if price and old and old <= price:
        old = None
    cur = str(r.get("currency") or "").upper()[:3]
    if not cur and price:
        cs = [c for c in plat["countries"] if c in CURRENCY_BY_COUNTRY]
        cur = CURRENCY_BY_COUNTRY[cs[0]] if len(plat["countries"]) == 1 and cs else "USD"

    cat = r.get("category") if r.get("category") in cats else plat["category"]
    expires = parse_date(r.get("expires"))
    if expires and expires < now_iso:
        return None, "منتهي"

    did = hashlib.sha1(f"{pid}|{canonical(url)}|{coupon.lower()}".encode()).hexdigest()[:12]
    deal = {
        "id": did, "platform": pid, "title": title, "type": typ, "category": cat, "url": url,
        "added": prev_added.get(did) or parse_date(r.get("added")) or now_iso,
    }
    if price:
        deal["price"] = round(price, 2)
        deal["currency"] = cur
    if old:
        deal["old_price"] = round(old, 2)
    if coupon:
        deal["coupon"] = coupon
    if r.get("badge"):
        deal["badge"] = str(r["badge"])[:40]
    if http_url(r.get("image")):
        deal["image"] = http_url(r["image"])
    if expires:
        deal["expires"] = expires
    return deal, None


# ---------------------------------------------------------------- المصادر
def source_url(src: dict):
    return os.environ.get(src["url_env"], "").strip() if src.get("url_env") else src.get("url", "")


def read_csv(src, data: bytes):
    text = data.decode("utf-8-sig", errors="replace")
    mp = src.get("map") or {}
    for row in csv.DictReader(io.StringIO(text)):
        row = {(k or "").strip().lower(): v for k, v in row.items()}
        yield {t: row.get((mp.get(t) or t).lower()) for t in
               ("title", "platform", "url", "price", "old_price", "currency", "type", "coupon", "category", "image", "badge", "expires", "added")}


def read_json(src, data: bytes):
    obj = json.loads(data.decode("utf-8"))
    items = get_path(obj, src.get("items_path", "")) if src.get("items_path") else obj
    mp = src.get("map") or {}
    for it in items or []:
        yield {t: get_path(it, mp.get(t) or t) for t in
               ("title", "platform", "url", "price", "old_price", "currency", "type", "coupon", "category", "image", "badge", "expires", "added")}


def read_rss(src, data: bytes):
    root = ET.fromstring(data)
    ns = {"a": "http://www.w3.org/2005/Atom", "m": "http://search.yahoo.com/mrss/"}
    for it in root.iter("item"):
        img = ""
        enc = it.find("enclosure")
        if enc is not None and "image" in (enc.get("type") or "image"):
            img = enc.get("url") or ""
        mc = it.find("m:content", ns)
        if mc is not None and not img:
            img = mc.get("url") or ""
        yield {"title": (it.findtext("title") or ""), "url": (it.findtext("link") or ""),
               "expires": None, "added": it.findtext("pubDate"), "image": img}
    for en in root.findall("a:entry", ns):
        link = en.find("a:link", ns)
        yield {"title": en.findtext("a:title", default="", namespaces=ns),
               "url": link.get("href") if link is not None else "", "added": en.findtext("a:updated", namespaces=ns)}


READERS = {"csv": read_csv, "json": read_json, "rss": read_rss}


# ---------------------------------------------------------------- الرئيسي
def write_seo(cfg: dict, today: str):
    site = (cfg.get("site_url") or "").rstrip("/")
    real = site and "YOUR-SITE" not in site.upper()
    robots = "User-agent: *\nAllow: /\n" + (f"Sitemap: {site}/sitemap.xml\n" if real else "")
    (ROOT / "robots.txt").write_text(robots, encoding="utf-8")
    if real:
        urls = [f"{site}/", f"{site}/legal.html"]
        body = "".join(f"  <url><loc>{u}</loc></url>\n" for u in urls)
        (ROOT / "sitemap.xml").write_text(
            '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' + body + "</urlset>\n",
            encoding="utf-8")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="اطبع النتيجة بدون الكتابة على الملفات")
    ap.add_argument("--out", default=str(ROOT / "data" / "deals.json"))
    ap.add_argument("--sources", default=str(ROOT / "scraper" / "sources.json"))
    args = ap.parse_args()

    cfg = load_json(ROOT / "config.json", {})
    pl = load_json(ROOT / "platforms.json", {})
    platforms, pmap = pl["platforms"], {p["id"]: p for p in pl["platforms"]}
    cats = {c["id"] for c in pl["categories"]}
    sources = (load_json(Path(args.sources), {}) or {}).get("sources", [])

    out_path = Path(args.out)
    prev = load_json(out_path, {"deals": []}) or {"deals": []}
    prev_added = {d["id"]: d.get("added") for d in prev.get("deals", []) if d.get("id")}
    now_iso = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    found, seen, skipped, ran = [], set(), {}, 0
    for src in sources:
        if not src.get("enabled", True):
            continue
        url = source_url(src)
        if not url:
            log(f"⏭  تخطي «{src.get('name')}»: لا يوجد رابط (راجع {src.get('url_env', 'url')})")
            continue
        try:
            raw_items = list(READERS[src["type"]](src, http_get(url)))
        except Exception as e:  # noqa: BLE001 - مصدر واحد فاشل ما يوقفش الباقي
            log(f"⚠️  فشل المصدر «{src.get('name')}»: {e}")
            continue
        ran += 1
        n_ok = 0
        for raw in raw_items:
            deal, why = normalize(raw, src.get("defaults", {}), pmap, platforms, cats, prev_added, now_iso)
            if not deal:
                skipped[why] = skipped.get(why, 0) + 1
                continue
            if deal["id"] in seen:
                continue
            seen.add(deal["id"])
            found.append(deal)
            n_ok += 1
        log(f"✅ «{src.get('name')}»: {n_ok} عرض من {len(raw_items)}")

    for why, n in sorted(skipped.items(), key=lambda x: -x[1])[:6]:
        log(f"   تم تجاهل {n}: {why}")

    if not found:
        if prev.get("deals"):
            log("لم يتم العثور على عروض جديدة — الإبقاء على الملف الحالي كما هو.")
        else:
            log("لا توجد عروض (راجع scraper/sources.json وSHEET_CSV_URL).")
        write_seo(cfg, now_iso[:10]) if not args.dry_run else None
        return 0

    found.sort(key=lambda d: d["added"], reverse=True)
    found = found[:MAX_DEALS]

    changed = [{k: v for k, v in d.items()} for d in found] != [d for d in prev.get("deals", [])]
    result = {"updated_at": now_iso if changed else prev.get("updated_at", now_iso), "count": len(found), "deals": found}
    if args.dry_run:
        print(json.dumps(result, ensure_ascii=False, indent=1))
        return 0
    if changed or not out_path.exists():
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(result, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        log(f"تم حفظ {len(found)} عرض في {out_path}")
    else:
        log("لا تغييرات في العروض.")
    write_seo(cfg, now_iso[:10])
    return 0


if __name__ == "__main__":
    sys.exit(main())
