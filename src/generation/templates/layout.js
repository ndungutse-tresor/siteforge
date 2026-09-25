'use strict';
const { theme: getTheme } = require('./themes');
const { STRINGS } = require('./strings');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const ICON = {
  phone: '<path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1z"/>',
  chat: '<path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2zm0 18.2a8.2 8.2 0 0 1-4.2-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2z"/>',
  mail: '<path d="M3 5h18a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zm9 7.2L4.4 7H4v.4l8 5.4 8-5.4V7h-.4z"/>',
  pin: '<path d="M12 2a7 7 0 0 0-7 7c0 5.2 7 13 7 13s7-7.8 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z"/>',
  clock: '<path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 10.4 3.5 2.1-.8 1.3L11 13V6.5h2z"/>'
};
const icon = (name) => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${ICON[name]}</svg>`;

function css(t) {
  const c = t.colors, d = t.dark;
  const vars = (x) => `--bg:${x.bg};--surface:${x.surface};--ink:${x.ink};--muted:${x.muted};--accent:${x.accent};--accent-ink:${x.accentInk};--band:${x.band};`;
  const font = t.font === 'serif'
    ? `Georgia,'Iowan Old Style','Times New Roman',serif`
    : `system-ui,-apple-system,'Segoe UI',Roboto,Ubuntu,sans-serif`;
  return `:root{${vars(c)}color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{${vars(d)}}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:17px/1.6 system-ui,-apple-system,'Segoe UI',Roboto,Ubuntu,sans-serif}
h1,h2,h3{font-family:${font};line-height:1.2;margin:0 0 .5em;overflow-wrap:break-word}
h1{font-size:clamp(2rem,6vw,3.2rem)}h2{font-size:clamp(1.5rem,4vw,2.1rem)}h3{font-size:1.15rem}
a{color:var(--accent)}img{max-width:100%;display:block}
.wrap{max-width:1080px;margin:0 auto;padding:0 20px}
.ic{width:1.15em;height:1.15em;fill:currentColor;flex:none}
.preview{background:#111;color:#fff;text-align:center;font-size:14px;padding:8px 12px;position:sticky;top:0;z-index:10}
header.top{background:var(--surface);border-bottom:1px solid color-mix(in srgb,var(--ink) 10%,transparent)}
header.top .wrap{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:60px;flex-wrap:wrap}
.brand{font-family:${font};font-weight:700;font-size:1.2rem;color:var(--ink);text-decoration:none}
.langs{display:flex;gap:6px;font-size:14px}
.langs a{padding:4px 10px;border-radius:99px;text-decoration:none;color:var(--muted);border:1px solid color-mix(in srgb,var(--ink) 15%,transparent)}
.langs a[aria-current]{background:var(--accent);color:var(--accent-ink);border-color:var(--accent)}
.btn{display:inline-flex;align-items:center;gap:8px;padding:13px 22px;border-radius:10px;background:var(--accent);color:var(--accent-ink);font-weight:600;text-decoration:none;min-height:48px}
.btn.alt{background:transparent;color:var(--ink);border:2px solid color-mix(in srgb,var(--ink) 25%,transparent)}
.actions{display:flex;flex-wrap:wrap;gap:12px;margin-top:24px}
.hero{padding:56px 0}.hero p.sub{font-size:1.15rem;color:var(--muted);max-width:40em}
.hero.center{background:var(--band);text-align:center}.hero.center p.sub{margin:0 auto}.hero.center .actions{justify-content:center}
.hero.split .wrap{display:grid;gap:32px;align-items:center}
.hero.split img{border-radius:16px;aspect-ratio:4/3;object-fit:cover;width:100%}
@media (min-width:800px){.hero.split .wrap{grid-template-columns:1.1fr 1fr}.hero{padding:88px 0}}
.hero.banner{position:relative;color:#fff;background:#222 center/cover no-repeat;padding:120px 0 96px}
.hero.banner::before{content:"";position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,.35),rgba(0,0,0,.65))}
.hero.banner .wrap{position:relative}.hero.banner p.sub{color:rgba(255,255,255,.88)}
.hero.banner .btn.alt{color:#fff;border-color:rgba(255,255,255,.6)}
.hero.banner.noimg{background:var(--accent);color:var(--accent-ink)}.hero.banner.noimg::before{display:none}
.hero.banner.noimg p.sub{color:inherit;opacity:.9}.hero.banner.noimg .btn{background:var(--accent-ink);color:var(--accent)}
.hero.banner.noimg .btn.alt{background:transparent;color:inherit;border-color:currentColor}
section.block{padding:56px 0}section.block.band{background:var(--band)}
.about p{max-width:46em;font-size:1.08rem}
.grid{display:grid;gap:18px;grid-template-columns:repeat(auto-fill,minmax(250px,1fr))}
.card{background:var(--surface);border-radius:14px;padding:22px;border:1px solid color-mix(in srgb,var(--ink) 8%,transparent)}
.card p{margin:0;color:var(--muted)}
.why ul{list-style:none;padding:0;margin:0;display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(240px,1fr))}
.why li{display:flex;gap:12px;align-items:flex-start;background:var(--surface);padding:16px 18px;border-radius:12px}
.why li::before{content:"";flex:none;width:10px;height:10px;margin-top:.55em;border-radius:50%;background:var(--accent)}
.gallery .grid{grid-template-columns:repeat(auto-fill,minmax(220px,1fr))}
.gallery img{border-radius:12px;aspect-ratio:1;object-fit:cover;width:100%}
.hours table{border-collapse:collapse;width:100%;max-width:480px}.hours td{padding:8px 0;border-bottom:1px solid color-mix(in srgb,var(--ink) 10%,transparent)}
.contact .rows{display:grid;gap:12px;max-width:560px}
.contact .row{display:flex;gap:12px;align-items:center;background:var(--surface);padding:14px 18px;border-radius:12px;text-decoration:none;color:var(--ink);min-height:52px}
.contact .row .ic{color:var(--accent)}
footer{padding:32px 0 96px;color:var(--muted);font-size:14px}
.fab{position:fixed;right:16px;bottom:16px;z-index:5;border-radius:99px;box-shadow:0 6px 20px rgba(0,0,0,.25)}
@media (min-width:800px){footer{padding-bottom:40px}}`;
}

function sectionHtml(key, ctx) {
  const { c, s, brief, up } = ctx;
  switch (key) {
    case 'about':
      return `<section class="block about" id="about"><div class="wrap"><h2>${esc(s.about)}</h2><p>${esc(c.about_paragraph)}</p></div></section>`;
    case 'services':
      return `<section class="block band services" id="services"><div class="wrap"><h2>${esc(s.services)}</h2><div class="grid">${
        c.services.map((x) => `<div class="card"><h3>${esc(x.title)}</h3><p>${esc(x.description)}</p></div>`).join('')}</div></div></section>`;
    case 'why':
      return `<section class="block why"><div class="wrap"><h2>${esc(s.why)}</h2><ul>${c.why_us.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div></section>`;
    case 'gallery': {
      const pics = brief.photos.slice(1);
      if (!pics.length) return '';
      return `<section class="block gallery"><div class="wrap"><h2>${esc(s.gallery)}</h2><div class="grid">${
        pics.map((p) => `<img src="${esc(up + 'img/' + p)}" alt="${esc(brief.business_name)}" loading="lazy">`).join('')}</div></div></section>`;
    }
    case 'hours':
      if (!brief.hours.length) return '';
      return `<section class="block hours"><div class="wrap"><h2>${esc(s.hours)}</h2><table>${brief.hours.map((h) => {
        const m = h.match(/^([^:]+):\s*(.+)$/);
        return m ? `<tr><td>${esc(m[1])}</td><td>${esc(m[2])}</td></tr>` : `<tr><td colspan="2">${esc(h)}</td></tr>`;
      }).join('')}</table></div></section>`;
    case 'contact': {
      const rows = [];
      if (brief.phone) rows.push(`<a class="row" href="tel:${esc(brief.phone.replace(/\s/g, ''))}">${icon('phone')}<span>${esc(s.call)}: ${esc(brief.phone)}</span></a>`);
      if (brief.whatsapp) rows.push(`<a class="row" href="https://wa.me/${esc(brief.whatsapp)}">${icon('chat')}<span>${esc(s.whatsapp)}</span></a>`);
      if (brief.email) rows.push(`<a class="row" href="mailto:${esc(brief.email)}">${icon('mail')}<span>${esc(brief.email)}</span></a>`);
      const where = [brief.address, brief.area, brief.district, 'Kigali'].filter(Boolean).join(', ');
      rows.push(`<a class="row" href="https://www.google.com/maps/search/?api=1&amp;query=${esc(encodeURIComponent(brief.map_query))}" rel="noopener">${icon('pin')}<span>${esc(where)} · ${esc(s.map)}</span></a>`);
      return `<section class="block band contact" id="contact"><div class="wrap"><h2>${esc(s.contact)}</h2><div class="rows">${rows.join('')}</div></div></section>`;
    }
    default:
      return '';
  }
}

function jsonLd(brief, c) {
  const data = {
    '@context': 'https://schema.org',
    '@type': 'LocalBusiness',
    name: brief.business_name,
    description: c.meta_description,
    address: { '@type': 'PostalAddress', addressLocality: 'Kigali', addressRegion: brief.district || undefined, addressCountry: 'RW', streetAddress: brief.address || undefined },
    telephone: brief.phone || undefined,
    email: brief.email || undefined
  };
  return JSON.stringify(data).replace(/</g, '\\u003c');
}

// Renders one language version of the site. `up` is the path back to the site root.
function renderPage({ brief, content, lang, preview, brand }) {
  const t = getTheme(brief.template);
  const s = STRINGS[lang];
  const c = content[lang];
  const primary = brief.languages[0];
  const up = lang === primary ? '' : '../';
  const hrefFor = (l) => (l === primary ? up || './' : `${up}${l}/`);
  const hero = brief.photos[0] ? `${up}img/${brief.photos[0]}` : null;

  const ctaHref = brief.whatsapp ? `https://wa.me/${brief.whatsapp}` : brief.phone ? `tel:${brief.phone.replace(/\s/g, '')}` : '#contact';
  const actions = `<div class="actions"><a class="btn" href="${esc(ctaHref)}">${icon(brief.whatsapp ? 'chat' : 'phone')}${esc(c.cta_text)}</a>${
    brief.phone && brief.whatsapp ? `<a class="btn alt" href="tel:${esc(brief.phone.replace(/\s/g, ''))}">${icon('phone')}${esc(s.call)}</a>` : ''}</div>`;

  let heroHtml;
  if (t.hero === 'split') {
    heroHtml = `<section class="hero split"><div class="wrap"><div><h1>${esc(c.hero_headline)}</h1><p class="sub">${esc(c.hero_sub)}</p>${actions}</div>${
      hero ? `<img src="${esc(hero)}" alt="${esc(brief.business_name)}">` : ''}</div></section>`;
  } else if (t.hero === 'banner') {
    heroHtml = `<section class="hero banner${hero ? '' : ' noimg'}"${hero ? ` style="background-image:url('${esc(hero)}')"` : ''}><div class="wrap"><h1>${esc(c.hero_headline)}</h1><p class="sub">${esc(c.hero_sub)}</p>${actions}</div></section>`;
  } else {
    heroHtml = `<section class="hero center"><div class="wrap"><h1>${esc(c.hero_headline)}</h1><p class="sub">${esc(c.hero_sub)}</p>${actions}</div></section>`;
  }

  const langs = brief.languages.length > 1
    ? `<nav class="langs" aria-label="Language">${brief.languages.map((l) => `<a href="${esc(hrefFor(l))}" hreflang="${l}"${l === lang ? ' aria-current="page"' : ''}>${esc(STRINGS[l].name)}</a>`).join('')}</nav>`
    : '';

  const body = t.order.map((k) => sectionHtml(k, { c, s, brief, up })).join('\n');
  const year = new Date().getFullYear();

  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(brief.business_name)} – ${esc(c.hero_headline === brief.business_name ? brief.sector_label : c.hero_headline)}</title>
<meta name="description" content="${esc(c.meta_description)}">
${preview ? '<meta name="robots" content="noindex, nofollow">' : ''}
<meta property="og:title" content="${esc(brief.business_name)}">
<meta property="og:description" content="${esc(c.meta_description)}">
${hero ? `<meta property="og:image" content="${esc(hero)}">` : ''}
${brief.languages.map((l) => `<link rel="alternate" hreflang="${l}" href="${esc(hrefFor(l))}">`).join('\n')}
<style>${css(t)}</style>
<script type="application/ld+json">${jsonLd(brief, c)}</script>
</head>
<body>
${preview ? `<div class="preview">${esc(s.preview)}${lang !== 'en' ? ' · Sample – not yet published' : ''}</div>` : ''}
<header class="top"><div class="wrap"><a class="brand" href="${esc(hrefFor(primary))}">${esc(brief.business_name)}</a>${langs}</div></header>
<main>
${heroHtml}
${body}
</main>
<footer><div class="wrap">© ${year} ${esc(brief.business_name)} · ${esc(s.madeBy)} ${esc(brand)}</div></footer>
${brief.whatsapp ? `<a class="btn fab" href="https://wa.me/${esc(brief.whatsapp)}" aria-label="WhatsApp">${icon('chat')}</a>` : ''}
</body>
</html>
`;
}

// Page shown instead of the site when hosting is suspended for non-payment.
function renderSuspended({ business_name, brand, contact }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(business_name)}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:17px/1.6 system-ui,sans-serif;background:#f5f5f4;color:#222;padding:24px}
@media (prefers-color-scheme:dark){body{background:#161616;color:#eee}}main{max-width:460px;text-align:center}</style></head>
<body><main><h1>${esc(business_name)}</h1><p>This website is temporarily offline while hosting is renewed.</p>
<p>Uru rubuga rwahagaritswe by'agateganyo mu gihe hategerejwe kwishyura.</p>
<p><small>${esc(brand)} · ${esc(contact)}</small></p></main></body></html>`;
}

module.exports = { renderPage, renderSuspended, esc };
