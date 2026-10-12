/* صيدة — منطق الواجهة. بدون مكتبات خارجية. */
(() => {
  'use strict';

  /* ---------- أدوات ---------- */
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
  const safeUrl = (u) => {
    try { const x = new URL(String(u)); return /^https?:$/.test(x.protocol) ? x.href : ''; }
    catch { return ''; }
  };
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* تجاهل */ } }
  };
  const num = (n) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
  const CUR = { EGP: 'ج.م', SAR: 'ر.س', AED: 'د.إ', KWD: 'د.ك', MAD: 'د.م', USD: '$' };
  const TYPE_LABEL = { deal: 'خصم', coupon: 'كوبون', free: 'مجاني' };
  const REL = 'sponsored nofollow noopener';
  const PRODUCT_CATS = new Set(['general', 'electronics', 'fashion', 'grocery', 'home', 'health', 'kids', 'games', 'software']);
  const PAGE = 12;

  // تطبيع النص العربي للبحث: يشيل التشكيل والتطويل ويوحّد الهمزات والياء/الألف المقصورة والتاء المربوطة
  const norm = (s) => String(s || '').toLowerCase()
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
    .replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d))
    .trim();

  const plural = (n, [one, two, few, many]) =>
    n === 1 ? one : n === 2 ? two : n >= 3 && n <= 10 ? `${n} ${few}` : `${n} ${many}`;

  const fgOn = (hex) => {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return '#fff';
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].substr(i, 2), 16) / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.5 ? '#1b1b1b' : '#fff';
  };

  /* ---------- الحالة ---------- */
  const S = {
    cfg: {}, countries: [], cats: [], plats: [], PMAP: {}, deals: [], updated: null,
    country: 'ALL', platform: '', category: '', type: 'all', sort: 'new', q: '', shown: PAGE, allPlatforms: false
  };

  /* ---------- روابط الأفلييت ---------- */
  // mode=param: يضيف باراميتر (tag عند أمازون). mode=template: رابط شبكة فيه {url} أو {url_raw}.
  function affiliateUrl(raw, platformId) {
    const a = (S.cfg.affiliates || {})[platformId];
    if (!a || !raw) return raw;
    try {
      if (a.mode === 'param' && a.value) {
        const u = new URL(raw);
        u.searchParams.set(a.param || 'tag', a.value);
        return u.toString();
      }
      if (a.mode === 'template' && a.template) {
        return a.template
          .replace('{url_raw}', () => raw)
          .replace('{url}', () => encodeURIComponent(raw));
      }
    } catch { /* نرجع للرابط العادي */ }
    return raw;
  }

  function searchLink(p, q) {
    if (p.search) {
      const direct = p.search.replace('{q}', () => encodeURIComponent(q));
      return { url: affiliateUrl(direct, p.id), direct: true };
    }
    return { url: 'https://www.google.com/search?q=' + encodeURIComponent(`site:${p.domain} ${q}`), direct: false };
  }

  /* ---------- تحميل ---------- */
  async function getJson(path, required) {
    try {
      const r = await fetch(path, { cache: 'no-cache' });
      if (!r.ok) throw new Error(r.status);
      return await r.json();
    } catch (e) {
      if (required) throw e;
      return null;
    }
  }

  async function init() {
    try {
      const [cfg, pl] = await Promise.all([getJson('config.json', true), getJson('platforms.json', true)]);
      S.cfg = cfg; S.countries = pl.countries; S.cats = pl.categories; S.plats = pl.platforms;
    } catch {
      document.body.insertAdjacentHTML('afterbegin',
        '<div class="demo-note" style="margin:90px 16px 0">تعذّر تحميل ملفات الإعدادات. إذا كنت تفتح الصفحة بالنقر المزدوج على الملف، شغّلها عبر سيرفر محلي (python -m http.server) أو ارفعها على الاستضافة.</div>');
      return;
    }
    S.plats.forEach((p) => { S.PMAP[p.id] = p; });

    const d = await getJson('data/deals.json', false);
    if (d) { S.deals = (d.deals || []).filter((x) => S.PMAP[x.platform] && x.title && safeUrl(x.url)); S.updated = d.updated_at; }

    applyBrand();
    readUrl();
    wire();
    renderAll();
    renderStaticAds();
    setupAnalytics();
    if (S.q) { $('#q').value = S.q; showResults(false); }
  }

  /* ---------- هوية الموقع ---------- */
  function applyBrand() {
    const { brand = {}, social = {}, contact_email: mail, site_url: site } = S.cfg;
    $$('[data-brand]').forEach((e) => { e.textContent = brand.name || 'صيدة'; });
    $$('[data-brand-emoji]').forEach((e) => { e.textContent = brand.emoji || '🎯'; });
    document.title = `${brand.name || 'صيدة'} | كل عروض المتاجر والكوبونات في مصر والوطن العربي`;
    if (site && !/YOUR-SITE/i.test(site)) {
      const l = document.createElement('link'); l.rel = 'canonical'; l.href = site; document.head.appendChild(l);
    }
    $$('[data-social]').forEach((a) => {
      const v = safeUrl(social[a.dataset.social]);
      if (v) { a.href = v; } else { a.hidden = true; }
    });
    if (!safeUrl(social.telegram) && !safeUrl(social.whatsapp)) { const t = $('#telegram'); if (t) t.hidden = true; }
    $$('[data-mail]').forEach((a) => { a.href = 'mailto:' + (mail || ''); });
  }

  /* ---------- URL ---------- */
  function readUrl() {
    const u = new URLSearchParams(location.search);
    const saved = store.get('saida_country');
    const def = S.cfg.default_country || 'EG';
    const validC = (c) => c === 'ALL' || S.countries.some((x) => x.id === c);
    S.country = [u.get('c'), saved, def].find((c) => c && validC(c)) || 'ALL';
    const p = u.get('p'); if (p && S.PMAP[p]) S.platform = p;
    const t = u.get('t'); if (['deal', 'coupon', 'free'].includes(t)) S.type = t;
    S.q = (u.get('q') || '').slice(0, 120);
  }

  function writeUrl() {
    const u = new URLSearchParams();
    if (S.platform) u.set('p', S.platform);
    if (S.q) u.set('q', S.q);
    if (S.type !== 'all') u.set('t', S.type);
    const qs = u.toString();
    try { history.replaceState(null, '', location.pathname + (qs ? '?' + qs : '') + location.hash); } catch { /* تجاهل */ }
  }

  /* ---------- مساعدات البيانات ---------- */
  const inCountry = (p) => S.country === 'ALL' || p.countries.includes('*') || p.countries.includes(S.country);
  const platList = () => S.plats.filter(inCountry);
  const expired = (d) => d.expires && Date.parse(d.expires) < Date.now();
  const catOf = (d) => d.category || S.PMAP[d.platform].category;

  function discount(d) {
    if (Number(d.old_price) > Number(d.price) && Number(d.price) > 0) return Math.round((1 - d.price / d.old_price) * 100);
    return Number(d.discount) > 0 ? Math.round(d.discount) : 0;
  }

  function liveDeals() {
    return S.deals.filter((d) => !expired(d) && inCountry(S.PMAP[d.platform]));
  }

  function filteredDeals() {
    let list = liveDeals().filter((d) =>
      (!S.platform || d.platform === S.platform) &&
      (!S.category || catOf(d) === S.category) &&
      (S.type === 'all' || d.type === S.type));
    const added = (d) => Date.parse(d.added) || 0;
    if (S.sort === 'discount') list.sort((a, b) => discount(b) - discount(a) || added(b) - added(a));
    else if (S.sort === 'ending') list.sort((a, b) => (a.expires ? Date.parse(a.expires) : Infinity) - (b.expires ? Date.parse(b.expires) : Infinity));
    else list.sort((a, b) => added(b) - added(a));
    return list;
  }

  /* ---------- مكوّنات صغيرة ---------- */
  function badge(p, cls = '') {
    const letter = (p.en || p.name).trim().charAt(0).toUpperCase();
    const inner = p.logo && safeUrl(p.logo)
      ? `<img src="${esc(safeUrl(p.logo))}" alt="" loading="lazy">`
      : esc(letter);
    return `<span class="p-badge ${cls}" style="background:${esc(p.color)};color:${fgOn(p.color)}" aria-hidden="true">${inner}</span>`;
  }

  function expiryText(iso) {
    if (!iso) return '';
    const ms = Date.parse(iso) - Date.now();
    if (!(ms > 0)) return '';
    const h = Math.floor(ms / 36e5), d = Math.floor(ms / 864e5);
    if (h < 1) return { t: 'ينتهي خلال أقل من ساعة', soon: true };
    if (h < 24) return { t: 'ينتهي خلال ' + plural(h, ['ساعة', 'ساعتين', 'ساعات', 'ساعة']), soon: true };
    if (d <= 14) return { t: 'ينتهي خلال ' + plural(d, ['يوم', 'يومين', 'أيام', 'يومًا']), soon: false };
    return { t: 'ينتهي ' + new Date(iso).toLocaleDateString('ar-EG', { day: 'numeric', month: 'long' }), soon: false };
  }

  function ago(iso) {
    const m = Math.floor((Date.now() - Date.parse(iso)) / 6e4);
    if (!(m >= 0)) return '';
    if (m < 2) return 'الآن';
    if (m < 60) return 'منذ ' + plural(m, ['دقيقة', 'دقيقتين', 'دقائق', 'دقيقة']);
    const h = Math.floor(m / 60);
    if (h < 24) return 'منذ ' + plural(h, ['ساعة', 'ساعتين', 'ساعات', 'ساعة']);
    return 'منذ ' + plural(Math.floor(h / 24), ['يوم', 'يومين', 'أيام', 'يومًا']);
  }

  function dealCard(d) {
    const p = S.PMAP[d.platform];
    const href = affiliateUrl(safeUrl(d.url), d.platform);
    const off = discount(d);
    const exp = expiryText(d.expires);
    const cur = CUR[d.currency] || d.currency || '';
    const hasImg = !!safeUrl(d.image);
    const media = hasImg
      ? `<img src="${esc(safeUrl(d.image))}" alt="" loading="lazy" referrerpolicy="no-referrer">`
      : badge(p);
    const cta = d.type === 'coupon' ? 'افتح المتجر واستخدم الكود' : d.type === 'free' ? 'احصل عليه مجانًا' : 'شاهد العرض';
    return `<article class="deal">
      <div class="d-media ${hasImg ? '' : 'no-img'}" data-pid="${esc(d.platform)}" style="--c:${esc(p.color)}">${media}
        ${off ? `<span class="d-off"><bdi dir="ltr">-${off}%</bdi></span>` : ''}
        <span class="d-type">${esc(TYPE_LABEL[d.type] || 'عرض')}</span>
        ${d.demo ? '<span class="d-demo">تجريبي</span>' : ''}
      </div>
      <div class="d-body">
        <div class="d-store"><span class="dot" style="background:${esc(p.color)}"></span>${esc(p.name)}</div>
        <h3 class="d-title">${esc(d.title)}</h3>
        ${Number(d.price) > 0 ? `<div class="d-price"><span class="d-now">${num(d.price)} <small>${esc(cur)}</small></span>${Number(d.old_price) > Number(d.price) ? `<span class="d-old">${num(d.old_price)}</span>` : ''}</div>` : ''}
        ${d.badge ? `<span class="d-badge">${esc(d.badge)}</span>` : ''}
        ${d.coupon ? `<div class="coupon"><code>${esc(d.coupon)}</code><button type="button" data-copy="${esc(d.coupon)}">نسخ</button></div>` : ''}
        ${exp ? `<div class="d-exp ${exp.soon ? 'soon' : ''}">${esc(exp.t)}</div>` : ''}
        <div class="d-cta"><a class="btn btn-primary" href="${esc(href)}" target="_blank" rel="${REL}" data-track="deal:${esc(d.id)}">${cta}</a></div>
      </div>
    </article>`;
  }

  /* ---------- الإعلانات (غير مزعجة: داخل المحتوى فقط، وعليها كلمة إعلان) ---------- */
  let adsenseLoaded = false;
  function loadAdsense(client) {
    if (adsenseLoaded) return; adsenseLoaded = true;
    const s = document.createElement('script');
    s.async = true; s.crossOrigin = 'anonymous';
    s.src = 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=' + encodeURIComponent(client);
    document.head.appendChild(s);
  }

  function houseAds() {
    const hasTg = !!safeUrl((S.cfg.social || {}).telegram);
    return ((S.cfg.ads || {}).house || []).filter((a) => a.url !== '#telegram' || hasTg);
  }

  function adHtml(slot, idx, asCard) {
    const ads = S.cfg.ads || {};
    if (!ads.enabled) return '';
    const cls = asCard ? 'deal ad' : 'ad ad-banner';
    const client = ads.adsense_client, slotId = (ads.adsense_slots || {})[slot];
    if (client && slotId) {
      loadAdsense(client);
      return `<div class="${cls}"><span class="ad-label">إعلان</span><ins class="adsbygoogle" style="display:block;width:100%" data-ad-client="${esc(client)}" data-ad-slot="${esc(slotId)}" data-ad-format="auto" data-full-width-responsive="true"></ins></div>`;
    }
    const list = houseAds();
    if (!list.length) return '';
    const a = list[idx % list.length];
    let url = a.url || '#';
    if (url === '#contact') url = 'mailto:' + (S.cfg.contact_email || '');
    const external = /^https?:/i.test(url);
    return `<div class="${cls} ad-house"><span class="ad-label">إعلان</span><h4>${esc(a.title)}</h4><p>${esc(a.text)}</p>
      <a class="btn btn-ghost" href="${esc(url)}" ${external ? `target="_blank" rel="${REL}"` : ''}>${esc(a.cta || 'المزيد')}</a></div>`;
  }

  function pushAdsense(root) {
    if (!root.querySelector('.adsbygoogle')) return;
    $$('.adsbygoogle', root).forEach(() => { try { (window.adsbygoogle = window.adsbygoogle || []).push({}); } catch { /* تجاهل */ } });
  }

  function renderStaticAds() {
    $$('.ad-slot').forEach((el, i) => { el.innerHTML = adHtml(el.dataset.slot, i, false); pushAdsense(el); });
  }

  /* ---------- الرسم ---------- */
  function renderAll() {
    renderCountryBar(); renderSelect(); renderQuick(); renderCategoryChips();
    renderPlatformGrid(); renderDeals(); syncTabs();
  }

  function renderCountryBar() {
    const items = S.countries.map((c) => ({ id: c.id, label: `${c.flag} ${c.name}` })).concat([{ id: 'ALL', label: 'كل الدول' }]);
    $('#countryBar').innerHTML = items.map((c) =>
      `<button type="button" data-country="${esc(c.id)}" aria-pressed="${S.country === c.id}">${esc(c.label)}</button>`).join('');
  }

  function renderSelect() {
    const sel = $('#platformSelect');
    const list = platList();
    let html = `<option value="">كل المتاجر</option>`;
    S.cats.forEach((c) => {
      const items = list.filter((p) => p.category === c.id);
      if (items.length) html += `<optgroup label="${esc(c.icon + ' ' + c.name)}">` +
        items.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('') + '</optgroup>';
    });
    sel.innerHTML = html;
    sel.value = S.platform && list.some((p) => p.id === S.platform) ? S.platform : '';
  }

  function renderQuick() {
    const list = platList().filter((p) => p.featured).slice(0, 7);
    $('#quickPlatforms').innerHTML = list.map((p) =>
      `<button type="button" data-quick="${esc(p.id)}" aria-pressed="${S.platform === p.id}">${esc(p.name)}</button>`).join('');
  }

  function renderCategoryChips() {
    const have = new Set(platList().map((p) => p.category));
    const chips = [{ id: '', label: 'كل الأقسام' }].concat(S.cats.filter((c) => have.has(c.id)).map((c) => ({ id: c.id, label: `${c.icon} ${c.name}` })));
    $('#categoryChips').innerHTML = chips.map((c) =>
      `<button type="button" class="chip" data-cat="${esc(c.id)}" aria-pressed="${S.category === c.id}">${esc(c.label)}</button>`).join('');
  }

  function renderPlatformGrid() {
    const LIMIT = 12;
    const list = platList().filter((p) => !S.category || p.category === S.category)
      .sort((a, b) => (b.featured ? 1 : 0) - (a.featured ? 1 : 0));
    const collapsible = !S.category && list.length > LIMIT;
    const view = collapsible && !S.allPlatforms ? list.slice(0, LIMIT) : list;
    const counts = {};
    liveDeals().forEach((d) => { counts[d.platform] = (counts[d.platform] || 0) + 1; });
    const scope = (p) => {
      if (p.countries.includes('*')) return '🌍 عالمي';
      if (S.country === 'ALL' || p.countries.length > 1)
        return p.countries.map((id) => (S.countries.find((c) => c.id === id) || {}).flag || id).join(' ');
      return '';
    };
    const catName = (id) => { const c = S.cats.find((x) => x.id === id) || {}; return `${c.icon || ''} ${c.name || ''}`; };
    $('#platformsCount').textContent = `${list.length} متجر وتطبيق — اضغط على أي متجر لعرض عروضه`;
    $('#platformGrid').innerHTML = view.map((p) => {
      const n = counts[p.id] || 0, sc = scope(p);
      return `<div class="p-card" data-selected="${S.platform === p.id}">
        <button type="button" class="p-pick" data-pick="${esc(p.id)}" aria-pressed="${S.platform === p.id}">
          ${badge(p)}<span><span class="p-name">${esc(p.name)}</span><span class="p-en" style="display:block">${esc(p.en)}</span></span>
        </button>
        <div class="p-meta"><span class="tag">${esc(catName(p.category))}</span>${p.kind === 'app' ? '<span class="tag tag-app">تطبيق</span>' : ''}${sc ? `<span class="tag">${esc(sc)}</span>` : ''}</div>
        <div class="p-foot"><span class="p-count">${n ? plural(n, ['عرض واحد', 'عرضان', 'عروض', 'عرضًا']) : ''}</span>
          <a class="p-open" href="${esc(affiliateUrl(p.home, p.id))}" target="_blank" rel="${REL}" data-track="store:${esc(p.id)}">فتح المتجر</a></div>
      </div>`;
    }).join('') || '<div class="empty">لا توجد متاجر في هذا القسم.</div>';
    const mb = $('#morePlatforms');
    mb.hidden = !collapsible;
    mb.textContent = S.allPlatforms ? 'عرض عدد أقل' : `عرض كل المتاجر (${list.length})`;
  }

  function renderDeals() {
    const all = filteredDeals();
    const p = S.PMAP[S.platform];
    $('#dealsTitle').textContent = p ? `عروض ${p.name}` : 'أحدث العروض والكوبونات';
    const bits = [`${all.length} عرض`];
    if (S.updated) { const a = ago(S.updated); if (a) bits.push('آخر تحديث ' + a); }
    $('#dealsMeta').textContent = bits.join(' — ');
    $('#demoNote').hidden = !S.deals.some((d) => d.demo);

    // الفلاتر النشطة
    const f = [];
    if (p) f.push(`<button class="chip" type="button" data-clear="platform" aria-label="إزالة فلتر المتجر">${esc(p.name)} ✕</button>`);
    if (S.category) { const c = S.cats.find((x) => x.id === S.category); f.push(`<button class="chip" type="button" data-clear="category" aria-label="إزالة فلتر القسم">${esc(c ? c.name : S.category)} ✕</button>`); }
    const af = $('#activeFilter');
    af.hidden = !f.length;
    af.innerHTML = f.length ? 'تصفية حسب: ' + f.join('') + '<button class="link-btn" type="button" data-clear="all">مسح الكل</button>' : '';

    const grid = $('#dealGrid'), empty = $('#dealEmpty');
    const slice = all.slice(0, S.shown);
    const every = Math.max(4, Number((S.cfg.ads || {}).infeed_every) || 9);
    let html = '';
    slice.forEach((d, i) => {
      html += dealCard(d);
      if ((i + 1) % every === 0 && i + 1 < slice.length) html += adHtml('infeed', Math.floor(i / every), true);
    });
    grid.innerHTML = html;
    pushAdsense(grid);

    if (!all.length) {
      empty.hidden = false;
      empty.innerHTML = p
        ? `<strong>لا توجد عروض مسجّلة لـ ${esc(p.name)} حاليًا</strong>يمكنك البحث عن منتج محدد داخل المتجر من خانة البحث بالأعلى، أو <a href="${esc(affiliateUrl(p.home, p.id))}" target="_blank" rel="${REL}">فتح المتجر مباشرة</a>.`
        : '<strong>لا توجد عروض مطابقة</strong>جرّب تغيير الدولة أو نوع العرض.';
    } else empty.hidden = true;
    $('#moreBtn').hidden = all.length <= S.shown;
  }

  function syncTabs() {
    $$('#typeTabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.type === S.type)));
    $('#sortSel').value = S.sort;
  }

  /* ---------- البحث ---------- */
  function showResults(scroll = true) {
    const q = S.q, p = S.PMAP[S.platform];
    const box = $('#resultsBody'), sec = $('#results');
    $('#resultsTitle').textContent = `نتائج البحث عن «${q}»`;
    let html = '';
    const list = platList().filter((x) => x.id !== S.platform);
    const btn = (x) => {
      const l = searchLink(x, q);
      return `<a class="r-btn" href="${esc(l.url)}" target="_blank" rel="${REL}" data-track="search:${esc(x.id)}">${badge(x)}<span>${esc(x.name)}<small>${l.direct ? 'بحث مباشر في المتجر' : 'بحث عبر جوجل داخل الموقع'}</small></span></a>`;
    };

    if (p) {
      const l = searchLink(p, q);
      html += `<div class="r-primary">${badge(p)}<div class="grow"><strong>ابحث عن «${esc(q)}» في ${esc(p.name)}</strong><span class="muted">${l.direct ? 'سيفتح المتجر على نتائج البحث مباشرة' : 'هذا المتجر لا يوفّر رابط بحث مباشر هنا، فنبحث فيه عبر جوجل'}</span></div>
        <a class="btn btn-primary" href="${esc(l.url)}" target="_blank" rel="${REL}" data-track="search:${esc(p.id)}">افتح النتائج في ${esc(p.name)}</a></div>`;
      const related = PRODUCT_CATS.has(p.category)
        ? list.filter((x) => PRODUCT_CATS.has(x.category) && (x.category === p.category || p.category === 'general' || x.category === 'general'))
        : list.filter((x) => x.category === p.category);
      const alt = related.sort((a, b) => ((b.search ? 1 : 0) - (a.search ? 1 : 0)) || ((b.featured ? 1 : 0) - (a.featured ? 1 : 0))).slice(0, 8);
      if (alt.length) html += `<h3 class="r-sub">جرّبه أيضًا في متاجر أخرى</h3><div class="r-btns">${alt.map(btn).join('')}</div>`;
    } else {
      const sorted = list.slice().sort((a, b) => ((b.featured ? 1 : 0) - (a.featured ? 1 : 0)) || ((b.search ? 1 : 0) - (a.search ? 1 : 0)));
      const top = sorted.filter((x) => x.search && PRODUCT_CATS.has(x.category)).slice(0, 12);
      const rest = sorted.filter((x) => !top.includes(x));
      html += `<p class="r-lead">اختر المتجر الذي تريد البحث فيه عن «${esc(q)}»:</p><div class="r-btns">${top.map(btn).join('')}</div>`;
      if (rest.length) html += `<details><summary class="link-btn" style="cursor:pointer">متاجر وخدمات أخرى (${rest.length})</summary><div class="r-btns" style="margin-top:10px">${rest.map(btn).join('')}</div></details>`;
    }

    // عروض مطابقة من قاعدة بياناتنا
    const nq = norm(q).split(/\s+/).filter(Boolean);
    const match = liveDeals().filter((d) => (!S.platform || d.platform === S.platform) &&
      nq.every((w) => norm(`${d.title} ${S.PMAP[d.platform].name} ${S.PMAP[d.platform].en} ${d.coupon || ''} ${d.badge || ''}`).includes(w))).slice(0, 6);
    html += `<h3 class="r-sub">عروض مطابقة عندنا</h3>` + (match.length
      ? `<div class="d-grid">${match.map(dealCard).join('')}</div>`
      : '<p class="muted">لا توجد عروض مسجّلة مطابقة لهذا البحث حاليًا. استخدم أزرار البحث المباشر بالأعلى.</p>');
    html += '<p class="r-note">الأسعار والتوفّر تظهر لك في صفحة المتجر وقد تختلف عمّا ذُكر هنا.</p>';
    box.innerHTML = html;
    sec.hidden = false;
    writeUrl();
    if (scroll) sec.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  }

  function closeResults() { S.q = ''; $('#results').hidden = true; $('#q').value = ''; writeUrl(); }

  /* ---------- الأحداث ---------- */
  function setPlatform(id) {
    S.platform = id || '';
    S.shown = PAGE;
    $('#platformSelect').value = S.platform;
    renderQuick(); renderPlatformGrid(); renderDeals(); writeUrl();
  }

  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 1800);
  }

  function track(kind) {
    try { if (window.gtag) window.gtag('event', 'select_content', { content_type: kind.split(':')[0], item_id: kind.split(':')[1] }); } catch { /* تجاهل */ }
  }

  function wire() {
    const smooth = () => (matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth');

    $('#searchForm').addEventListener('submit', (e) => {
      e.preventDefault();
      S.q = $('#q').value.trim().slice(0, 120);
      if (!S.q) {
        if (S.platform) $('#deals').scrollIntoView({ behavior: smooth() }); else $('#q').focus();
        return;
      }
      showResults();
    });
    $('#platformSelect').addEventListener('change', (e) => { setPlatform(e.target.value); if (S.q) showResults(false); });
    $('#resultsClose').addEventListener('click', closeResults);

    document.addEventListener('click', (e) => {
      const t = e.target.closest('[data-country],[data-quick],[data-cat],[data-pick],[data-type],[data-clear],[data-copy],[data-track],[data-jump-type],#moreBtn,#morePlatforms');
      if (!t) return;
      if (t.dataset.country) {
        S.country = t.dataset.country; store.set('saida_country', S.country);
        if (S.platform && !inCountry(S.PMAP[S.platform])) S.platform = '';
        if (S.category && !platList().some((p) => p.category === S.category)) S.category = '';
        S.shown = PAGE; renderAll(); writeUrl(); if (S.q) showResults(false);
      } else if (t.dataset.quick) {
        setPlatform(S.platform === t.dataset.quick ? '' : t.dataset.quick);
        if (S.q) showResults(false);
      } else if (t.dataset.pick) {
        setPlatform(S.platform === t.dataset.pick ? '' : t.dataset.pick);
        if (S.platform) $('#deals').scrollIntoView({ behavior: smooth() });
        if (S.q) showResults(false);
      } else if (t.dataset.cat !== undefined && t.matches('.chip[data-cat]')) {
        S.category = t.dataset.cat; S.shown = PAGE; renderCategoryChips(); renderPlatformGrid(); renderDeals();
      } else if (t.dataset.type && t.closest('#typeTabs')) {
        S.type = t.dataset.type; S.shown = PAGE; syncTabs(); renderDeals(); writeUrl();
      } else if (t.dataset.jumpType) {
        S.type = t.dataset.jumpType; S.shown = PAGE; syncTabs(); renderDeals(); writeUrl();
      } else if (t.dataset.clear) {
        if (t.dataset.clear !== 'category') { S.platform = ''; $('#platformSelect').value = ''; }
        if (t.dataset.clear !== 'platform') S.category = '';
        S.shown = PAGE; renderQuick(); renderCategoryChips(); renderPlatformGrid(); renderDeals(); writeUrl();
      } else if (t.dataset.copy) {
        copy(t.dataset.copy);
      } else if (t.id === 'moreBtn') {
        S.shown += PAGE; renderDeals();
      } else if (t.id === 'morePlatforms') {
        S.allPlatforms = !S.allPlatforms; renderPlatformGrid();
      }
      if (t.dataset.track) track(t.dataset.track);
    });

    $('#sortSel').addEventListener('change', (e) => { S.sort = e.target.value; renderDeals(); });

    // صورة المنتج لو فشلت: نرجع للتصميم البديل
    $('#dealGrid').addEventListener('error', (e) => {
      const img = e.target;
      if (img.tagName !== 'IMG') return;
      const m = img.closest('.d-media'); if (!m) return;
      const p = S.PMAP[m.dataset.pid]; img.remove();
      if (p) { m.classList.add('no-img'); m.insertAdjacentHTML('afterbegin', badge(p)); }
    }, true);

    const nav = $('#nav');
    const onScroll = () => nav.classList.toggle('scrolled', window.scrollY > 10);
    onScroll(); document.addEventListener('scroll', onScroll, { passive: true });
  }

  async function copy(text) {
    try { await navigator.clipboard.writeText(text); }
    catch {
      const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch { /* تجاهل */ }
      ta.remove();
    }
    toast('تم نسخ الكود: ' + text);
  }

  /* ---------- التحليلات (اختيارية) ---------- */
  function setupAnalytics() {
    const a = S.cfg.analytics || {};
    if (/^G-[A-Z0-9]+$/i.test(a.ga4_id || '')) {
      const s = document.createElement('script'); s.async = true;
      s.src = 'https://www.googletagmanager.com/gtag/js?id=' + a.ga4_id; document.head.appendChild(s);
      window.dataLayer = window.dataLayer || [];
      window.gtag = function () { window.dataLayer.push(arguments); };
      window.gtag('js', new Date()); window.gtag('config', a.ga4_id);
    }
    if (a.cloudflare_token) {
      const s = document.createElement('script'); s.defer = true;
      s.src = 'https://static.cloudflareinsights.com/beacon.min.js';
      s.setAttribute('data-cf-beacon', JSON.stringify({ token: a.cloudflare_token }));
      document.head.appendChild(s);
    }
  }

  init();
})();
