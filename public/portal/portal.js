'use strict';
(() => {
  const { icon, logoMark } = window.SF;
  const I18N = window.SF_I18N;

  // ---------- language ----------
  const LANGS = Object.keys(I18N.languages);
  const readLang = () => { try { return localStorage.getItem('sf_lang'); } catch (e) { return null; } };
  const saveLang = (l) => { try { localStorage.setItem('sf_lang', l); } catch (e) { /* private mode: keep it for this visit only */ } };
  let lang = LANGS.includes(readLang()) ? readLang() : 'en';

  // t('key', { n: 2 }) -> the text in the current language, falling back to English.
  function t(key, params = {}) {
    const s = I18N[lang]?.[key] ?? I18N.en[key] ?? key;
    return s.replace(/\{(\w+)\}/g, (_, k) => (params[k] ?? ''));
  }
  const tErr = (msg) => I18N.errors[msg]?.[lang] || msg;

  // ---------- tiny DOM helper (same idea as the admin panel) ----------
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className = v;
      else if (k === 'value') el.value = v;
      else if (k === 'width') el.style.width = v; // CSSOM, allowed by the CSP (a style attribute is not)
      else if (k === 'checked' || k === 'disabled' || k === 'required' || k === 'selected') el[k] = Boolean(v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }
  const $app = document.getElementById('app');

  // Money: RWF 12,500 (en) · 12,500 Frw (rw) · 12 500 RWF (fr)
  function rwf(n) {
    const num = Number(n || 0).toLocaleString('en-US');
    if (lang === 'rw') return `${num} Frw`;
    if (lang === 'fr') return `${num.replace(/,/g, ' ')} RWF`;
    return `RWF ${num}`;
  }
  const toDate = (s) => new Date(String(s).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(s)) ? '' : 'Z'));
  function day(s) {
    if (!s) return '';
    const d = toDate(s);
    if (isNaN(d)) return String(s).slice(0, 10);
    return `${d.getDate()} ${I18N.months[lang][d.getMonth()]} ${d.getFullYear()}`;
  }
  function when(s) {
    if (!s) return '';
    const d = toDate(s);
    if (isNaN(d)) return String(s).slice(0, 16);
    const mins = Math.round((Date.now() - d) / 60000);
    if (mins < 1) return t('just_now');
    if (mins < 60) return t('min_ago', { n: mins });
    if (mins < 60 * 24) return t('h_ago', { n: Math.round(mins / 60) });
    return `${d.getDate()} ${I18N.months[lang][d.getMonth()]} · ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  const initials = (name) => String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');

  function toast(msg, err) {
    const el = h('div', { class: 'toast' + (err ? ' err' : ''), role: 'status' }, msg);
    document.body.append(el);
    setTimeout(() => el.remove(), err ? 6000 : 3500);
  }

  async function api(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: 'same-origin'
    });
    const json = await res.json().catch(() => ({}));
    // A session that ran out sends the client to the login page (but just checking "am I logged in?" does not).
    if (res.status === 401 && !/\/(login|signup|me)$/.test(path)) { state.me = null; go('#/login'); throw new Error(t('err_login_again')); }
    if (!res.ok) throw new Error(json.message ? tErr(json.message) : t('err_generic', { status: res.status }));
    return json;
  }

  async function act(btn, fn, okMsg) {
    if (btn) btn.disabled = true;
    try {
      const r = await fn();
      if (okMsg) toast(typeof okMsg === 'function' ? okMsg(r) : okMsg);
      return r;
    } catch (e) {
      toast(e.message, true);
      return null;
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  const state = { me: null, config: null, services: [], intent: null, toPay: 0 };
  let refreshTimer = null;

  async function setLang(l) {
    if (!LANGS.includes(l) || l === lang) return;
    lang = l;
    saveLang(l);
    if (state.me) api('POST', '/api/portal/lang', { lang: l }).then((r) => { state.me = r.user; }).catch(() => {});
    render();
  }
  function langSelect(extraClass = '') {
    const sel = h('select', { 'aria-label': t('lang_label'), onchange: (e) => setLang(e.target.value) },
      LANGS.map((l) => h('option', { value: l, selected: l === lang }, I18N.languages[l])));
    return h('label', { class: 'lang ' + extraClass, title: t('lang_label') }, icon('globe', 'sm'), sel);
  }

  const STATUS_CLASS = { awaiting_deposit: 'warn', in_progress: 'info', awaiting_final: 'warn', completed: 'good', cancelled: '' };
  const statusBadge = (s) => h('span', { class: 'badge ' + (STATUS_CLASS[s] ?? '') }, t('st_' + s));
  const progressBar = (n) => h('div', { class: 'progress', role: 'progressbar', 'aria-valuenow': n, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-label': t('mock_progress') },
    h('div', { width: `${Math.max(2, Math.min(100, n))}%` }));
  const SERVICE_ICON = { 'new-website': 'globe', 'website-update': 'refresh', 'domain-email': 'at', hosting: 'server', 'it-support': 'wrench', chatbot: 'bot' };
  function iconForName(name) {
    const n = String(name || '').toLowerCase();
    if (/domain|email/.test(n)) return 'at';
    if (/host/.test(n)) return 'server';
    if (/update|redesign/.test(n)) return 'refresh';
    if (/support|it /.test(n)) return 'wrench';
    if (/bot|chat/.test(n)) return 'bot';
    if (/web|site/.test(n)) return 'globe';
    return 'spark';
  }
  const serviceTile = (slugOrName) => h('span', { class: 'tile' }, icon(SERVICE_ICON[slugOrName] || iconForName(slugOrName)));
  // Service names and descriptions in the current language (admins can edit the translations).
  const sName = (s) => s.i18n?.[lang]?.name || s.name;
  const sDesc = (s) => s.i18n?.[lang]?.description || s.description;
  const orderName = (o) => o.service_i18n?.[lang]?.name || o.service_name;
  const logo = (href = '#/') => h('a', { class: 'logo', href }, logoMark(), state.config.brand);

  // System updates are stored with a code, so they read naturally in every language.
  function updateText(u) {
    if (!u.code) return u.message;
    const p = { ...(u.params || {}) };
    if (p.amount != null) p.amount = rwf(p.amount);
    switch (u.code) {
      case 'payment_reported': return t(p.kind === 'final' ? 'u_payment_reported_final' : 'u_payment_reported_deposit', p);
      case 'order_cancelled': return p.by === 'client' ? t('u_order_cancelled_client') : t('u_order_cancelled_admin', p).trim();
      default: return I18N.en['u_' + u.code] ? t('u_' + u.code, p) : u.message;
    }
  }

  // ---------- routing (hash based) ----------
  function go(hash) {
    if (location.hash === hash) render(); else location.hash = hash;
  }
  window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });

  async function boot() {
    try {
      const r = await api('GET', '/api/portal/services');
      state.config = r;
      state.services = r.services;
    } catch (e) { state.config = { brand: 'SiteForge', advance_percent: 50, momo: null }; }
    try { state.me = (await api('GET', '/api/portal/me')).user; } catch (e) { state.me = null; }
    // A client who chose a language on another device gets it here too.
    if (state.me && !readLang() && LANGS.includes(state.me.lang)) lang = state.me.lang;
    render();
  }

  function render() {
    clearInterval(refreshTimer);
    window.onscroll = null;
    document.documentElement.lang = lang;
    const [, page = '', arg = ''] = (location.hash || '#/').match(/^#\/?([a-z]*)\/?(\d*)/) || [];
    document.title = `${state.config.brand} · ${t('title')}`;
    if (!state.me) {
      if (['orders', 'order', 'new', 'account'].includes(page)) {
        if (page === 'new' && arg) state.intent = arg;
        return go('#/login');
      }
      if (page === 'login') return authView('login');
      if (page === 'signup') return authView('signup');
      return landingView();
    }
    if (page === 'login' || page === 'signup') return go('#/');
    const views = { '': overviewView, orders: ordersView, new: newOrderView, order: orderView, account: accountView };
    appShell(page || 'overview', (main) => (views[page] || overviewView)(main, arg));
  }

  // ====================== public site ======================
  function landingView() {
    const pct = state.config.advance_percent;
    const rest = 100 - pct;
    const scrollTo = (id) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    const header = h('header', { class: 'site-header' }, h('div', { class: 'container' },
      logo(),
      h('nav', { class: 'site-nav', 'aria-label': t('nav_services') },
        h('button', { onclick: () => scrollTo('services') }, t('nav_services')),
        h('button', { onclick: () => scrollTo('how') }, t('nav_how')),
        h('button', { onclick: () => scrollTo('faq') }, t('nav_faq'))),
      h('span', { class: 'spacer' }),
      langSelect(),
      h('a', { class: 'btn ghost hide-sm', href: '#/login' }, t('login')),
      h('a', { class: 'btn primary', href: '#/signup' }, t('get_started'))));
    window.onscroll = () => header.classList.toggle('scrolled', window.scrollY > 8);

    // Hero with a preview of what an order looks like inside the portal.
    const hero = h('section', { class: 'hero' }, h('div', { class: 'container' },
      h('div', { class: 'hero-copy' },
        h('span', { class: 'kicker' }, h('span', { class: 'dot' }, icon('spark')), t('kicker')),
        h('h1', {}, t('hero_1'), h('span', { class: 'hl' }, t('hero_2'))),
        h('p', { class: 'lead' }, t('hero_lead', { pct })),
        h('div', { class: 'hero-cta' },
          h('a', { class: 'btn primary lg', href: '#/signup' }, t('get_started'), icon('arrowRight')),
          h('button', { class: 'btn lg', onclick: () => scrollTo('services') }, t('hero_see'))),
        h('ul', { class: 'assurances' },
          h('li', {}, icon('checkCircle'), t('assure_split', { pct, rest })),
          h('li', {}, icon('checkCircle'), t('assure_momo')),
          h('li', {}, icon('checkCircle'), t('assure_track')))),
      h('div', { class: 'mock', 'aria-label': t('mock_aria'), role: 'img' },
        h('span', { class: 'mock-label' }, t('mock_label')),
        h('div', { class: 'mock-card' },
          h('div', { class: 'mock-top' }, serviceTile('new-website'), h('div', { class: 'mock-title' }, h('b', {}, t('mock_service')), h('span', {}, t('mock_order'))),
            h('span', { class: 'spacer' }), h('span', { class: 'badge info' }, t('st_in_progress'))),
          h('div', { class: 'mock-progress' }, h('div', { class: 'row' }, h('span', {}, t('mock_progress')), h('b', {}, '70%')), progressBar(70)),
          h('ul', { class: 'mock-feed' },
            h('li', {}, h('span', { class: 'av' }, icon('chat')), h('div', {}, t('mock_u1'), h('small', {}, t('mock_u1_meta')))),
            h('li', {}, h('span', { class: 'av' }, icon('chat')), h('div', {}, t('mock_u2'), h('small', {}, t('mock_u2_meta')))),
            h('li', {}, h('span', { class: 'av ok' }, icon('check')), h('div', {}, t('mock_u3'), h('small', {}, t('mock_u3_meta')))))),
        h('div', { class: 'mock-pay' }, h('span', { class: 'av' }, icon('wallet')), h('div', {}, h('b', {}, t('mock_pay_t')), h('span', {}, t('mock_pay_s')))))));

    const services = h('section', { class: 'section', id: 'services' }, h('div', { class: 'container' },
      h('div', { class: 'section-head' }, h('span', { class: 'eyebrow' }, t('sv_eyebrow')), h('h2', {}, t('sv_title')), h('p', {}, t('sv_lead'))),
      state.services.length ? h('div', { class: 'services' }, state.services.map(serviceCard))
        : h('div', { class: 'card empty' }, icon('clock'), h('b', {}, t('sv_empty_t')), h('span', {}, t('sv_empty_s')),
          h('a', { class: 'btn primary', href: '#/signup' }, t('signup_cta')))));

    const how = h('section', { class: 'section alt', id: 'how' }, h('div', { class: 'container' },
      h('div', { class: 'section-head center' }, h('span', { class: 'eyebrow' }, t('how_eyebrow')), h('h2', {}, t('how_title'))),
      h('ol', { class: 'steps4' },
        h('li', {}, h('span', { class: 'tile' }, icon('orders')), h('b', {}, t('how1_t')), h('span', {}, t('how1_s'))),
        h('li', {}, h('span', { class: 'tile' }, icon('wallet')), h('b', {}, t('how2_t', { pct })), h('span', {}, t('how2_s'))),
        h('li', {}, h('span', { class: 'tile' }, icon('chart')), h('b', {}, t('how3_t')), h('span', {}, t('how3_s'))),
        h('li', {}, h('span', { class: 'tile' }, icon('checkCircle')), h('b', {}, t('how4_t')), h('span', {}, t('how4_s'))))));

    const trust = h('section', { class: 'section' }, h('div', { class: 'container' },
      h('div', { class: 'section-head' }, h('span', { class: 'eyebrow' }, t('trust_eyebrow')), h('h2', {}, t('trust_title'))),
      h('div', { class: 'features' },
        h('div', { class: 'card feature' }, h('span', { class: 'tile' }, icon('shield')), h('h3', {}, t('tr1_t')), h('p', {}, t('tr1_s', { pct, rest })),
          h('div', { class: 'split-bar', 'aria-hidden': 'true' }, h('span'), h('span')), h('div', { class: 'split-legend' }, h('span', {}, t('tr1_a', { pct })), h('span', {}, t('tr1_b', { rest })))),
        h('div', { class: 'card feature' }, h('span', { class: 'tile' }, icon('chart')), h('h3', {}, t('tr2_t')), h('p', {}, t('tr2_s'))),
        h('div', { class: 'card feature' }, h('span', { class: 'tile' }, icon('wallet')), h('h3', {}, t('tr3_t')), h('p', {}, t('tr3_s'))))));

    const faq = h('section', { class: 'section alt', id: 'faq' }, h('div', { class: 'container' },
      h('div', { class: 'section-head center' }, h('span', { class: 'eyebrow' }, t('faq_eyebrow')), h('h2', {}, t('faq_title'))),
      h('div', { class: 'faq' }, [1, 2, 3, 4, 5].map((i) =>
        h('details', {}, h('summary', {}, t(`faq${i}_q`), icon('chevronRight')), h('p', {}, t(`faq${i}_a`, { pct, rest })))))));

    const cta = h('section', { class: 'section' }, h('div', { class: 'container' }, h('div', { class: 'cta-band' },
      h('div', {}, h('h2', {}, t('cta_t')), h('p', {}, t('cta_s'))),
      h('span', { class: 'spacer' }), h('a', { class: 'btn primary lg', href: '#/signup' }, t('get_started'), icon('arrowRight')))));

    const footer = h('footer', { class: 'site-footer' }, h('div', { class: 'container' },
      logo(), h('span', {}, t('brand_tag')), h('span', { class: 'spacer' }), langSelect(),
      h('span', {}, `© ${new Date().getFullYear()} ${state.config.brand}`)));

    $app.replaceChildren(header, h('main', {}, hero, services, how, trust, faq, cta), footer);
  }

  function serviceCard(s) {
    const pct = state.config.advance_percent;
    return h('article', { class: 'card service' },
      serviceTile(s.slug),
      h('h3', {}, sName(s)),
      h('p', {}, sDesc(s)),
      h('div', { class: 'price-line' },
        h('div', { class: 'price money' }, rwf(s.price),
          h('small', {}, t('to_start', { amount: rwf(Math.round(s.price * pct / 100)) }), s.delivery_days ? ` · ${t('about_days', { n: s.delivery_days })}` : '')),
        h('a', { class: 'btn primary', href: `#/new/${s.id}` }, t('order_btn'))));
  }

  // ====================== sign in / sign up ======================
  function pwField(id, autocomplete) {
    const input = h('input', { id, type: 'password', autocomplete, required: true, minlength: autocomplete === 'new-password' ? 8 : null });
    const toggle = h('button', { type: 'button', 'aria-label': t('show_pw'), title: t('show_pw') }, icon('eye'));
    toggle.onclick = () => {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      toggle.setAttribute('aria-label', t(show ? 'hide_pw' : 'show_pw'));
    };
    return { input, el: h('div', { class: 'pw' }, input, toggle) };
  }

  function authView(mode) {
    const pct = state.config.advance_percent;
    const aside = h('aside', { class: 'auth-aside' },
      logo(),
      h('div', { class: 'pitch' },
        h('h2', {}, t(mode === 'login' ? 'auth_login_pitch' : 'auth_signup_pitch')),
        h('ul', {},
          h('li', {}, h('span', { class: 'tile' }, icon('shield')), h('div', {}, h('b', {}, t('auth_b1_t', { pct })), t('auth_b1_s'))),
          h('li', {}, h('span', { class: 'tile' }, icon('chart')), h('div', {}, h('b', {}, t('auth_b2_t')), t('auth_b2_s'))),
          h('li', {}, h('span', { class: 'tile' }, icon('wallet')), h('div', {}, h('b', {}, t('auth_b3_t')), t('auth_b3_s'))))),
      h('div', { class: 'foot' }, `© ${new Date().getFullYear()} ${state.config.brand}`));

    const topRow = h('div', { class: 'auth-top' }, h('a', { class: 'auth-back', href: '#/' }, icon('arrowLeft', 'sm'), t('back_site')), h('span', { class: 'spacer' }), langSelect());
    let form;
    if (mode === 'login') {
      const id = h('input', { id: 'login-id', autocomplete: 'username', required: true, placeholder: t('ph_identifier') });
      const pw = pwField('login-pw', 'current-password');
      const btn = h('button', { class: 'btn primary lg block', type: 'submit' }, t('login'));
      form = h('form', { class: 'auth-form', onsubmit: async (e) => {
        e.preventDefault();
        const r = await act(btn, () => api('POST', '/api/portal/login', { identifier: id.value, password: pw.input.value }));
        if (r) { state.me = r.user; afterLogin(); }
      } },
        topRow,
        h('h1', {}, t('login_title')), h('p', { class: 'sub' }, t('login_sub')),
        h('label', { class: 'f' }, t('f_identifier'), id),
        h('label', { class: 'f' }, t('f_password'), pw.el),
        btn,
        h('p', { class: 'small muted' }, t('forgot')),
        h('div', { class: 'or' }, t('new_here')),
        h('a', { class: 'btn lg block', href: '#/signup' }, t('signup_cta')));
    } else {
      const f = {
        name: h('input', { id: 'su-name', autocomplete: 'name', required: true, placeholder: t('ph_name') }),
        company: h('input', { id: 'su-company', autocomplete: 'organization', required: true, placeholder: t('ph_company') }),
        phone: h('input', { id: 'su-phone', type: 'tel', autocomplete: 'tel', placeholder: '078 123 4567' }),
        email: h('input', { id: 'su-email', type: 'email', autocomplete: 'email', placeholder: 'you@business.rw' })
      };
      const pw = pwField('su-pw', 'new-password');
      const btn = h('button', { class: 'btn primary lg block', type: 'submit' }, t('create_account'));
      form = h('form', { class: 'auth-form', onsubmit: async (e) => {
        e.preventDefault();
        const body = Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.value]));
        body.password = pw.input.value;
        body.lang = lang;
        const r = await act(btn, () => api('POST', '/api/portal/signup', body));
        if (r) { state.me = r.user; toast(t('welcome_toast')); afterLogin(); }
      } },
        topRow,
        h('h1', {}, t('signup_title')), h('p', { class: 'sub' }, t('signup_sub')),
        h('div', { class: 'form-row' }, h('label', { class: 'f' }, t('f_name'), f.name), h('label', { class: 'f' }, t('f_company'), f.company)),
        h('div', { class: 'form-row' }, h('label', { class: 'f' }, t('f_phone'), f.phone), h('label', { class: 'f' }, h('span', {}, t('f_email'), ' ', h('span', { class: 'hint' }, t('optional'))), f.email)),
        h('label', { class: 'f' }, h('span', {}, t('f_password'), ' ', h('span', { class: 'hint' }, t('pw_hint'))), pw.el),
        btn,
        h('p', { class: 'tiny muted' }, t('privacy')),
        h('div', { class: 'or' }, t('have_account')),
        h('a', { class: 'btn lg block', href: '#/login' }, t('login')));
    }
    $app.replaceChildren(h('div', { class: 'auth' }, aside, h('main', { class: 'auth-main' }, form)));
    form.querySelector('input')?.focus();
  }

  function afterLogin() {
    // Keep the language the client just used; remember it on their account too.
    if (state.me && state.me.lang !== lang) api('POST', '/api/portal/lang', { lang }).then((r) => { state.me = r.user; }).catch(() => {});
    const target = state.intent ? `#/new/${state.intent}` : '#/';
    state.intent = null;
    go(target);
  }

  // ====================== client app ======================
  function appShell(page, fill) {
    const u = state.me;
    const current = page === 'order' ? 'orders' : page;
    const nav = [['#/', 'overview', 'dashboard', t('nav_overview')], ['#/orders', 'orders', 'orders', t('nav_orders')], ['#/new', 'new', 'plus', t('nav_new')], ['#/account', 'account', 'user', t('nav_account')]];
    const logout = h('button', { class: 'btn ghost', title: t('logout'), 'aria-label': t('logout') }, icon('logout'));
    logout.onclick = async () => { await act(logout, () => api('POST', '/api/portal/logout', {})); state.me = null; go('#/'); };
    const main = h('main', { class: 'app-main', id: 'main' });
    $app.replaceChildren(h('div', { class: 'app' },
      h('aside', { class: 'sidebar' },
        logo(),
        h('nav', { class: 'side-nav', 'aria-label': t('nav_overview') }, nav.map(([href, key, ic, label]) =>
          h('a', { href, 'aria-current': current === key ? 'page' : null }, icon(ic), label,
            key === 'orders' && state.toPay ? h('span', { class: 'count', title: t('payments_due') }, state.toPay) : null))),
        h('div', { class: 'side-help' }, h('b', {}, t('help_t')), t('help_s')),
        langSelect('block'),
        h('div', { class: 'me' }, h('span', { class: 'avatar' }, initials(u.name)), h('div', { class: 'who' }, h('b', {}, u.name), h('span', {}, u.company)), logout)),
      h('div', {},
        h('div', { class: 'mobile-top' }, logo(), h('span', { class: 'spacer' }), langSelect(), h('span', { class: 'avatar' }, initials(u.name))),
        main),
      h('nav', { class: 'tabbar', 'aria-label': t('nav_overview') }, nav.map(([href, key, ic, label]) => h('a', { href, 'aria-current': current === key ? 'page' : null }, icon(ic), label)))));
    fill(main);
  }

  const pageHead = (title, sub, ...actions) => h('div', { class: 'page-head' },
    h('div', { class: 'titles' }, h('h1', {}, title), sub ? h('p', { class: 'sub' }, sub) : null), h('span', { class: 'spacer' }), actions);

  function greeting(name) {
    const hr = new Date().getHours();
    return t(hr < 12 ? 'greet_morning' : hr < 18 ? 'greet_afternoon' : 'greet_evening', { name });
  }

  async function overviewView(main) {
    const r = await api('GET', '/api/portal/overview').catch((e) => { toast(e.message, true); return null; });
    if (!r) return;
    state.toPay = r.to_pay.length;
    main.append(pageHead(greeting(state.me.name.split(/\s+/)[0]), state.me.company, h('a', { class: 'btn primary', href: '#/new' }, icon('plus'), t('nav_new'))));

    if (!r.counts.total) {
      main.append(h('div', { class: 'card empty' }, icon('spark'), h('h2', {}, t('first_order_t')), h('p', {}, t('first_order_s')),
        h('a', { class: 'btn primary', href: '#/new' }, t('choose_service'))));
      if (state.services.length) main.append(h('div', { class: 'pick' }, state.services.slice(0, 3).map(pickCard)));
      return;
    }

    main.append(h('div', { class: 'kpis' },
      kpi(t('kpi_open'), r.counts.open, 'orders'),
      kpi(t('kpi_progress'), r.counts.in_progress, 'chart'),
      kpi(t('kpi_topay'), rwf(r.to_pay_total), 'wallet', r.to_pay_total > 0),
      kpi(t('kpi_done'), r.counts.completed, 'checkCircle')));

    const attention = h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, t('attention'))),
      r.to_pay.length || r.checking.length
        ? [r.to_pay.map((o) => h('div', { class: 'action' }, serviceTile(o.service_name),
            h('div', { class: 'body' }, h('b', {}, orderName(o)), h('span', {}, t(o.due.kind === 'deposit' ? 'pay_deposit_line' : 'pay_balance_line', { amount: rwf(o.due.amount) }))),
            h('a', { class: 'btn primary', href: `#/order/${o.id}` }, t('pay_now')))),
          r.checking.map((o) => h('div', { class: 'action' }, serviceTile(o.service_name),
            h('div', { class: 'body' }, h('b', {}, orderName(o)), h('span', {}, t('checking_line'))),
            h('span', { class: 'badge warn' }, t('checking'))))]
        : h('p', { class: 'muted' }, t('nothing_todo')));

    const openList = h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, t('open_orders')), h('span', { class: 'spacer' }), h('a', { class: 'small', href: '#/orders' }, t('see_all'))),
      r.open.length ? r.open.map((o) => h('div', { class: 'action' }, serviceTile(o.service_name),
        h('div', { class: 'body' }, h('b', {}, orderName(o)), o.status === 'in_progress' ? progressBar(o.progress) : h('span', {}, t('st_' + o.status))),
        h('a', { class: 'btn', href: `#/order/${o.id}` }, t('open')))) : h('p', { class: 'muted' }, t('no_open')));

    const feed = h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, t('recent'))),
      h('ul', { class: 'feed' }, r.recent.map((u) => h('li', {}, feedAvatar(u.author),
        h('a', { href: `#/order/${u.order_id}` }, h('div', { class: 'who' }, h('b', {}, orderName(u)), ` · ${when(u.created_at)}`), h('div', { class: 'text' }, updateText(u)))))));

    main.append(h('div', { class: 'grid-main' }, h('div', { class: 'stack' }, attention, openList), feed));
  }

  function kpi(label, value, ic, accent) {
    return h('div', { class: 'card kpi' + (accent ? ' accent' : '') }, h('div', { class: 'top' }, h('span', {}, label), icon(ic)), h('b', { class: 'money' }, value));
  }

  const feedAvatar = (author) => h('span', { class: 'av ' + author }, icon(author === 'client' ? 'user' : author === 'admin' ? 'chat' : 'bolt'));

  async function ordersView(main) {
    const r = await api('GET', '/api/portal/orders').catch((e) => { toast(e.message, true); return null; });
    if (!r) return;
    const count = r.rows.length === 1 ? t('orders_count_one') : t('orders_count_other', { n: r.rows.length });
    main.append(pageHead(t('orders_title'), count, h('a', { class: 'btn primary', href: '#/new' }, icon('plus'), t('nav_new'))));
    if (!r.rows.length) {
      main.append(h('div', { class: 'card empty' }, icon('orders'), h('b', {}, t('no_orders')), h('a', { class: 'btn primary', href: '#/new' }, t('choose_service'))));
      return;
    }
    main.append(h('div', { class: 'order-list' }, r.rows.map((o) => h('a', { class: 'card order-item', href: `#/order/${o.id}` },
      serviceTile(o.service_name),
      h('div', { class: 'body' },
        h('div', { class: 'line1' }, h('b', {}, orderName(o)), statusBadge(o.status)),
        h('div', { class: 'meta' }, t('order_meta', { id: o.id, date: day(o.created_at), price: rwf(o.price) })),
        o.status === 'in_progress' ? progressBar(o.progress) : null),
      h('div', { class: 'end' },
        o.payment_pending ? h('span', { class: 'badge warn' }, t('pay_badge_checking'))
          : o.due ? h('span', { class: 'small' }, h('b', {}, t('to_pay_amount', { amount: rwf(o.due.amount) }))) : null,
        icon('chevronRight'))))));
  }

  function pickCard(s) {
    const pct = state.config.advance_percent;
    return h('a', { class: 'card', href: `#/new/${s.id}` }, serviceTile(s.slug), h('h3', {}, sName(s)), h('p', {}, sDesc(s)),
      h('div', { class: 'foot' }, h('span', { class: 'money' }, rwf(s.price)), h('span', { class: 'small muted' }, t('to_start', { amount: rwf(Math.round(s.price * pct / 100)) }))));
  }

  function newOrderView(main, serviceId) {
    if (!serviceId) {
      main.append(pageHead(t('new_title'), t('new_sub')));
      main.append(state.services.length ? h('div', { class: 'pick' }, state.services.map(pickCard))
        : h('div', { class: 'card empty' }, icon('clock'), t('sv_empty_t')));
      return;
    }
    const s = state.services.find((x) => String(x.id) === String(serviceId));
    if (!s) {
      main.append(h('div', { class: 'card empty' }, icon('info'), h('b', {}, t('unavailable')), h('a', { class: 'btn', href: '#/new' }, t('all_services'))));
      return;
    }
    const pct = state.config.advance_percent;
    const deposit = Math.round(s.price * pct / 100);
    const details = h('textarea', { id: 'order-details', rows: 6, required: true, placeholder: t('ph_details') });
    const website = h('input', { id: 'order-website', placeholder: 'yourbusiness.rw' });
    const btn = h('button', { class: 'btn primary lg', type: 'submit' }, t('place_order'), icon('arrowRight'));
    main.append(
      h('a', { class: 'back-link', href: '#/new' }, icon('arrowLeft', 'sm'), t('all_services')),
      pageHead(sName(s), t('new_form_sub')),
      h('div', { class: 'grid-main' },
        h('form', { class: 'card stack', onsubmit: async (e) => {
          e.preventDefault();
          const o = await act(btn, () => api('POST', '/api/portal/orders', { service_id: s.id, website: website.value, details: details.value }));
          if (o) { toast(t('order_placed_toast')); go(`#/order/${o.id}`); }
        } },
          h('div', { class: 'row' }, serviceTile(s.slug), h('p', { class: 'muted' }, sDesc(s))),
          h('label', { class: 'f' }, h('span', {}, t('f_details'), ' ', h('span', { class: 'hint' }, t('details_hint'))), details),
          h('label', { class: 'f' }, h('span', {}, t('f_website'), ' ', h('span', { class: 'hint' }, t('website_hint'))), website),
          h('div', {}, btn)),
        h('aside', { class: 'card stack' },
          h('h2', {}, t('price')),
          h('div', { class: 'summary-list' },
            h('div', { class: 'line' }, h('span', {}, t('to_start_pct', { pct })), h('span', { class: 'money' }, rwf(deposit))),
            h('div', { class: 'line' }, h('span', {}, t('on_delivery_pct', { pct: 100 - pct })), h('span', { class: 'money' }, rwf(s.price - deposit))),
            h('div', { class: 'line total' }, h('span', {}, t('total')), h('span', { class: 'money' }, rwf(s.price)))),
          s.delivery_days ? h('div', { class: 'note' }, icon('clock', 'sm'), t('ready_in', { n: s.delivery_days })) : null,
          h('div', { class: 'note info' }, icon('wallet', 'sm'), t('after_place')))));
  }

  const STEPS = [['step_placed', 'file'], ['step_deposit', 'wallet'], ['step_progress', 'chart'], ['step_finished', 'checkCircle'], ['step_delivered', 'spark']];
  function tracker(o) {
    const at = ['awaiting_deposit', 'in_progress', 'awaiting_final', 'completed'].indexOf(o.status);
    const reached = [true, at >= 1, at >= 1, at >= 2, at >= 3];
    const current = { awaiting_deposit: 1, in_progress: 2, awaiting_final: 4 }[o.status] ?? -1;
    return h('ol', { class: 'card tracker', 'aria-label': t('mock_progress') }, STEPS.map(([label, ic], i) =>
      h('li', { class: i === current ? 'now' : reached[i] ? 'done' : '' }, h('span', { class: 'dot' }, icon(reached[i] && i !== current ? 'check' : ic)), t(label))));
  }

  async function orderView(main, orderId) {
    let o;
    try { o = await api('GET', `/api/portal/orders/${orderId}`); } catch (e) {
      main.append(h('div', { class: 'card empty' }, icon('info'), h('b', {}, e.message), h('a', { class: 'btn', href: '#/orders' }, t('nav_orders'))));
      return;
    }
    const reload = () => render();
    main.append(
      h('a', { class: 'back-link', href: '#/orders' }, icon('arrowLeft', 'sm'), t('nav_orders')),
      pageHead(orderName(o), t('order_sub', { id: o.id, date: day(o.created_at) }), statusBadge(o.status)));
    if (o.status !== 'cancelled') main.append(tracker(o));

    const left = h('div', { class: 'stack' });
    const right = h('div', { class: 'stack' });
    main.append(h('div', { class: 'grid-main' }, left, right));

    // What happens now
    if (o.delivery) {
      left.append(h('section', { class: 'card status-card' },
        h('div', { class: 'big' }, h('span', { class: 'tile good' }, icon('checkCircle')), h('div', {}, h('h2', {}, t('complete_t')), h('p', { class: 'muted small' }, t('complete_s', { date: day(o.completed_at) })))),
        o.delivery.url ? h('a', { class: 'btn primary', href: o.delivery.url, target: '_blank', rel: 'noopener noreferrer' }, icon('external'), t('open_result')) : null,
        o.delivery.note ? h('div', { class: 'request' }, o.delivery.note) : null));
    } else if (o.payment_pending) {
      const p = o.payments.find((x) => x.status === 'pending');
      left.append(h('section', { class: 'card status-card' },
        h('div', { class: 'big' }, h('span', { class: 'tile warn' }, icon('clock')), h('div', {}, h('h2', {}, t('checking_t')),
          h('p', { class: 'muted small' }, `${rwf(p.amount)} · MoMo ID ${p.momo_txid}`))),
        h('p', { class: 'muted' }, t('checking_s'))));
    } else if (o.due) {
      left.append(payCard(o, reload));
    } else if (o.status === 'in_progress') {
      left.append(h('section', { class: 'card status-card' },
        h('div', { class: 'row' }, h('h2', {}, t('wip_t')), h('span', { class: 'spacer' }), h('b', { class: 'money' }, `${o.progress}%`)),
        progressBar(o.progress),
        h('p', { class: 'muted small' }, t('wip_s'))));
    }

    // Conversation
    const msg = h('textarea', { id: 'order-msg', rows: 3, placeholder: t('ph_message') });
    const send = h('button', { class: 'btn primary', type: 'submit' }, icon('send', 'sm'), t('send'));
    left.append(h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', {}, t('updates_t'))),
      h('ul', { class: 'feed' }, o.updates.slice().reverse().map((u) => h('li', {}, feedAvatar(u.author), h('div', {},
        h('div', { class: 'who' }, h('b', {}, u.author === 'admin' ? t('who_team', { brand: state.config.brand }) : u.author === 'client' ? t('who_you') : t('who_system')),
          ` · ${when(u.created_at)}${u.progress != null ? ` · ${t('pct_done', { n: u.progress })}` : ''}`),
        h('div', { class: 'text' }, updateText(u)))))),
      o.status !== 'cancelled' ? h('form', { class: 'composer', onsubmit: async (e) => {
        e.preventDefault();
        if (await act(send, () => api('POST', `/api/portal/orders/${o.id}/messages`, { message: msg.value }), t('message_sent'))) reload();
      } }, msg, h('div', { class: 'row' }, send)) : null));

    // Summary
    right.append(h('section', { class: 'card stack' },
      h('h2', {}, t('summary')),
      h('div', { class: 'summary-list' },
        h('div', { class: 'line' }, h('span', {}, t('deposit')), h('span', { class: 'money' }, rwf(o.deposit))),
        h('div', { class: 'line' }, h('span', {}, t('balance')), h('span', { class: 'money' }, rwf(o.balance))),
        h('div', { class: 'line total' }, h('span', {}, t('total')), h('span', { class: 'money' }, rwf(o.price))),
        h('div', { class: 'line' }, h('span', {}, t('paid_so_far')), h('b', { class: 'money' }, rwf(o.paid)))),
      h('div', { class: 'stack' }, h('span', { class: 'eyebrow' }, t('your_request')), h('div', { class: 'request' }, o.details),
        o.website ? h('div', { class: 'small muted' }, t('current_site', { url: o.website })) : null)));
    if (o.payments.length) {
      right.append(h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, t('payments'))),
        o.payments.map((p) => h('div', { class: 'pay-row' },
          h('div', {}, h('b', { class: 'money' }, rwf(p.amount)), h('span', { class: 'muted' }, ` · ${t(p.kind === 'deposit' ? 'kind_deposit' : 'kind_final')}`)),
          h('span', { class: 'badge ' + ({ confirmed: 'good', pending: 'warn', rejected: 'bad' }[p.status]) }, t('pay_' + p.status)),
          h('span', { class: 'mono' }, `MoMo ID ${p.momo_txid} · ${day(p.submitted_at)}`),
          p.status === 'rejected' && p.review_note ? h('span', { class: 'small bad-text' }, p.review_note) : null))));
    }
    const canCancel = o.status === 'awaiting_deposit' && !o.payments.some((p) => p.status !== 'rejected');
    if (canCancel) {
      const cancel = h('button', { class: 'btn danger block' }, t('cancel_order'));
      let armed = false;
      cancel.onclick = async () => {
        if (!armed) { armed = true; cancel.textContent = t('cancel_confirm'); return; }
        if (await act(cancel, () => api('POST', `/api/portal/orders/${o.id}/cancel`, {}), t('cancelled_toast'))) reload();
      };
      right.append(cancel);
    }

    // Keep the page current while the client waits for a confirmation or an update.
    if (!['completed', 'cancelled'].includes(o.status)) {
      refreshTimer = setInterval(async () => {
        if (document.hidden || ['TEXTAREA', 'INPUT', 'SELECT'].includes(document.activeElement?.tagName)) return;
        try {
          const fresh = await api('GET', `/api/portal/orders/${o.id}`);
          if (fresh.updated_at !== o.updated_at) reload();
        } catch (e) { /* offline: try again next time */ }
      }, 30000);
    }
  }

  const copyBtn = (text) => {
    const b = h('button', { class: 'btn', type: 'button' }, icon('copy', 'sm'), t('copy'));
    b.onclick = () => navigator.clipboard.writeText(text).then(() => toast(t('copied')), () => toast(t('copy_failed'), true));
    return b;
  };

  // How to pay: the MoMo Pay code (QR to scan, or tap to dial) and the MoMo number, then the transaction ID.
  function payCard(o, reload) {
    const momo = state.config.momo;
    const isDeposit = o.due.kind === 'deposit';
    const amount = rwf(o.due.amount);
    const txid = h('input', { id: 'pay-txid', required: true, autocomplete: 'off', placeholder: t('ph_txid') });
    const payer = h('input', { id: 'pay-phone', type: 'tel', placeholder: '078 123 4567' });
    const btn = h('button', { class: 'btn primary lg', type: 'submit' }, icon('check'), t('i_paid'));
    const m = momo?.merchant;

    const methods = momo ? h('div', { class: 'pay-methods' },
      m ? h('div', { class: 'merchant' },
        h('img', { class: 'qr', src: m.qr, alt: `QR ${m.ussd}` }),
        h('div', { class: 'merchant-body' },
          h('span', { class: 'eyebrow' }, t('m_merchant_t')),
          h('span', { class: 'small muted' }, t('m_merchant_s')),
          h('div', { class: 'ussd' }, m.ussd),
          h('span', { class: 'small muted' }, t('m_name', { name: m.name }), ' · ', t('enter_amount', { amount })),
          h('div', { class: 'row' }, h('a', { class: 'btn primary', href: m.tel }, icon('phone', 'sm'), t('dial')), copyBtn(m.ussd)),
          h('span', { class: 'tiny faint' }, t('ussd_note')))) : null,
      momo.number ? h('div', { class: 'momo' }, h('span', { class: 'brand-chip' }, 'MTN', h('br'), 'MoMo'),
        h('div', {}, h('div', { class: 'sub' }, t('m_number_t')), h('div', { class: 'n' }, momo.number), h('div', { class: 'sub' }, t('m_number_s', { name: momo.name, id: o.id }))),
        copyBtn(momo.number.replace(/\s+/g, ''))) : null)
      : h('div', { class: 'note warn' }, icon('info', 'sm'), t('momo_missing'));

    return h('section', { class: 'card pay-card' },
      h('div', {}, h('span', { class: 'eyebrow' }, t(isDeposit ? 'pay_eyebrow_deposit' : 'pay_eyebrow_final')),
        h('h2', {}, t(isDeposit ? 'pay_title_deposit' : 'pay_title_final'))),
      h('div', { class: 'amount money' }, amount),
      methods,
      momo ? h('ol', { class: 'pay-steps' },
        h('li', {}, t('pay_step1', { amount })), h('li', {}, t('pay_step2')), h('li', {}, t('pay_step3'))) : null,
      h('form', { class: 'stack', onsubmit: async (e) => {
        e.preventDefault();
        if (await act(btn, () => api('POST', `/api/portal/orders/${o.id}/payments`, { momo_txid: txid.value, payer_phone: payer.value }), t('paid_toast'))) reload();
      } },
        h('div', { class: 'form-row' },
          h('label', { class: 'f' }, t('f_txid'), txid),
          h('label', { class: 'f' }, h('span', {}, t('f_paid_from'), ' ', h('span', { class: 'hint' }, t('optional'))), payer)),
        h('div', {}, btn)));
  }

  function accountView(main) {
    const u = state.me;
    const cur = pwField('pw-current', 'current-password');
    const next = pwField('pw-next', 'new-password');
    const save = h('button', { class: 'btn primary', type: 'submit' }, t('change_pw'));
    const logout = h('button', { class: 'btn' }, icon('logout', 'sm'), t('logout'));
    logout.onclick = async () => { await act(logout, () => api('POST', '/api/portal/logout', {})); state.me = null; go('#/'); };
    const langChoice = h('div', { class: 'lang-choice', role: 'radiogroup', 'aria-label': t('lang_title') },
      LANGS.map((l) => h('button', { type: 'button', role: 'radio', 'aria-checked': String(l === lang), class: 'btn' + (l === lang ? ' primary' : ''), onclick: () => setLang(l) }, I18N.languages[l])));
    main.append(pageHead(t('account_title'), t('account_sub')), h('div', { class: 'grid-main' },
      h('div', { class: 'stack' },
        h('section', { class: 'card stack' },
          h('div', { class: 'row' }, h('span', { class: 'avatar' }, initials(u.name)), h('div', {}, h('h2', {}, u.name), h('p', { class: 'muted small' }, u.company))),
          h('dl', { class: 'kv' },
            h('dt', {}, t('f_phone')), h('dd', {}, u.phone || '–'), h('dt', {}, t('f_email')), h('dd', {}, u.email || '–'),
            h('dt', {}, t('f_member')), h('dd', {}, day(u.created_at))),
          h('div', { class: 'note' }, icon('info', 'sm'), t('details_note')),
          h('div', {}, logout)),
        h('section', { class: 'card stack' }, h('div', {}, h('h2', {}, t('lang_title')), h('p', { class: 'muted small' }, t('lang_sub'))), langChoice)),
      h('form', { class: 'card stack', onsubmit: async (e) => {
        e.preventDefault();
        if (await act(save, () => api('POST', '/api/portal/password', { current: cur.input.value, next: next.input.value }), t('pw_changed'))) { cur.input.value = ''; next.input.value = ''; }
      } }, h('h2', {}, t('pw_title')), h('label', { class: 'f' }, t('f_current_pw'), cur.el), h('label', { class: 'f' }, t('f_new_pw'), next.el), h('div', {}, save))));
  }

  boot();
})();
