"""بناء روابط الأفلييت — نفس منطق دالة affiliateUrl في js/app.js.

mode = "param"    : يضيف/يستبدل باراميتر في الرابط (مثل tag عند أمازون)
mode = "template" : رابط شبكة أفلييت فيه {url} (الرابط مشفّر) أو {url_raw} (كما هو)
لو value/template فاضي → يرجع الرابط الأصلي بدون عمولة.
"""
from urllib.parse import parse_qsl, quote, urlencode, urlsplit, urlunsplit


def build_affiliate_url(raw: str, platform_id: str, config: dict) -> str:
    aff = (config.get("affiliates") or {}).get(platform_id)
    if not aff or not raw:
        return raw
    mode = aff.get("mode")
    try:
        if mode == "param" and aff.get("value"):
            parts = urlsplit(raw)
            key = aff.get("param") or "tag"
            query = [(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True) if k != key]
            query.append((key, aff["value"]))
            return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query), parts.fragment))
        if mode == "template" and aff.get("template"):
            return aff["template"].replace("{url_raw}", raw).replace("{url}", quote(raw, safe=""))
    except Exception:  # noqa: BLE001 - لو حصل أي خطأ نرجع الرابط العادي
        pass
    return raw
