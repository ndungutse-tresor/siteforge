'use strict';
(() => {
  // ---------- tiny DOM helper ----------
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className = v;
      else if (k === 'style') el.style.cssText = v; // CSSOM, allowed by the CSP (a style attribute is not)
      else if (k === 'value') el.value = v;
      else if (k === 'checked' || k === 'selected' || k === 'disabled') el[k] = Boolean(v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }
  const $app = document.getElementById('app');
  const fmt = (n) => Number(n || 0).toLocaleString('en-US');
  const rwf = (n) => `RWF ${fmt(n)}`;
  // The database stores UTC ("2026-09-28 10:51:35"). Show it in this computer's time (Kigali: UTC+2).
  const when = (s) => {
    if (!s) return '';
    const str = String(s);
    if (/^\d{4}-\d\d-\d\d$/.test(str)) return str; // a plain date, e.g. paid-until
    const d = new Date(/[zZ]$|[+-]\d\d:?\d\d$/.test(str) ? str : str.replace(' ', 'T') + 'Z');
    if (isNaN(d)) return str.replace('T', ' ').slice(0, 16);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };

  function toast(msg, err) {
    const t = h('div', { class: 'toast' + (err ? ' err' : ''), role: 'status' }, msg);
    document.body.append(t);
    setTimeout(() => t.remove(), err ? 6000 : 3000);
  }

  async function api(method, path, body) {
    let res;
    try {
      res = await fetch(path, {
        method,
        headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
        body: body !== undefined ? JSON.stringify(body) : undefined,
        credentials: 'same-origin'
      });
    } catch (e) {
      throw new Error('Cannot reach the SiteForge server. Check that it is running (npm start) and try again.');
    }
    const json = await res.json().catch(() => ({}));
    if (res.status === 401 && path !== '/api/login') { state.me = null; render(); throw new Error('Please log in.'); }
    if (!res.ok) throw new Error(json.message || `Error ${res.status}`);
    return json;
  }

  // Runs an action with the button disabled and shows errors as a toast.
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

  const state = {
    me: null,
    view: 'pipeline',
    filters: { stage: '', sector: '', district: '', q: '', sort: 'score', hide_dnc: '1' },
    opp: { kind: 'new', sector: '', district: '', has_phone: '', collected: '' },
    portalTab: 'orders',
    orderFilter: '',
    orderId: null,
    prospectId: null,
    backTo: 'pipeline',
    tab: 'overview',
    lang: 'rw',
    frameMobile: false,
    previewSite: null
  };

  // ---------- shell ----------
  // Which screen the address points at: #p12/site, #o3, #portal/services, #opportunities…
  function fromHash() {
    const hsh = location.hash;
    const m = hsh.match(/^#p(\d+)(?:\/(\w+))?$/);
    if (m) Object.assign(state, { view: 'prospect', prospectId: Number(m[1]), tab: m[2] || 'overview' });
    else if (/^#(opportunities|clients|import|compliance)$/.test(hsh)) state.view = hsh.slice(1);
    else if (/^#portal(\/(orders|services|accounts))?$/.test(hsh)) Object.assign(state, { view: 'portal', portalTab: hsh.split('/')[1] || 'orders' });
    else if (/^#o\d+$/.test(hsh)) Object.assign(state, { view: 'order', orderId: Number(hsh.slice(2)) });
    else state.view = 'pipeline';
  }
  const hashFor = () => (state.view === 'prospect' ? `#p${state.prospectId}/${state.tab}` : state.view === 'order' ? `#o${state.orderId}`
    : state.view === 'portal' ? `#portal/${state.portalTab}` : state.view === 'pipeline' ? '' : `#${state.view}`);

  async function boot() {
    const r = await api('GET', '/api/me').catch(() => null);
    state.me = r && r.username ? r : null;
    fromHash();
    render();
  }

  function go(view, extra = {}) {
    // Opening a business remembers the list it was opened from, for the back button.
    if (view === 'prospect' && state.view !== 'prospect') state.backTo = state.view;
    Object.assign(state, { view }, extra);
    const hash = hashFor();
    // A new history entry, so the browser's Back and Forward buttons move between screens.
    if (hash !== location.hash && !(hash === '' && location.hash === '')) {
      history.pushState(null, '', location.pathname + location.search + hash);
    }
    render();
    window.scrollTo(0, 0);
  }

  // Back / Forward, or a link or typed address like #opportunities.
  window.addEventListener('hashchange', () => {
    if (!state.me) return;
    const before = state.view;
    fromHash();
    if (state.view === 'prospect' && before !== 'prospect') state.backTo = before;
    render();
  });

  // Page titles for views that don't draw their own header.
  const PAGE_HEAD = {
    pipeline: ['Pipeline', 'Every business we found. Score 0–100 shows how much they need a website: the higher, the better the prospect.'],
    opportunities: ['Opportunities', 'Who needs a new website, whose site needs an update, and what we know about them.'],
    import: ['Import', 'Bring businesses in from OpenStreetMap or your own list.'],
    compliance: ['Compliance', 'Google terms, personal data and the do-not-contact list.']
  };

  function render() {
    $app.replaceChildren();
    if (!state.me) return $app.append(loginView());
    const f = state.me.features;
    const current = { prospect: 'pipeline', order: 'portal' }[state.view] || state.view;
    const navItem = (key, ic, label, extra) => h('button', { 'aria-current': current === key ? 'page' : null, onclick: () => go(key) }, SF.icon(ic), label, extra);
    const feature = (label, on, onText, offText, offClass = 'off', title) => h('div', { class: 'f', title },
      label, h('span', { class: 'st ' + (on ? 'on' : offClass) }, on ? onText : offText));
    const logout = h('button', { class: 'btn ghost', title: 'Log out', 'aria-label': 'Log out', onclick: async () => { await api('POST', '/api/logout', {}); state.me = null; render(); } }, SF.icon('logout'));
    const main = h('main', { id: 'main' });
    $app.append(h('div', { class: 'shell' },
      h('aside', { class: 'side' },
        h('a', { class: 'logo', href: '#', onclick: (e) => { e.preventDefault(); go('pipeline'); } }, SF.logoMark(), h('span', {}, 'SiteForge', h('small', {}, 'Admin'))),
        h('nav', { class: 'nav', 'aria-label': 'Main' },
          navItem('pipeline', 'chart', 'Pipeline'),
          navItem('opportunities', 'target', 'Opportunities'),
          navItem('portal', 'store', 'Client portal', h('span', { id: 'portal-badge', class: 'badge nav-count', hidden: true, title: 'Payments to check' })),
          navItem('clients', 'briefcase', 'Hosting clients'),
          navItem('import', 'upload', 'Import'),
          navItem('compliance', 'shield', 'Compliance')),
        h('div', { class: 'feat' }, h('span', { class: 't' }, 'Connections'),
          feature('Claude', f.ai, 'on', 'off', 'warn', f.ai ? f.ai_model : 'No ANTHROPIC_API_KEY: sites get placeholder text'),
          feature('Google Places', f.places, 'on', 'off', 'off', 'GOOGLE_PLACES_API_KEY'),
          feature('Vercel', f.vercel, 'on', 'local', 'off', 'VERCEL_TOKEN')),
        h('div', { class: 'whoami' }, h('span', { class: 'avatar' }, String(state.me.username).slice(0, 2).toUpperCase()),
          h('div', {}, h('b', {}, state.me.username), h('span', {}, 'Administrator')), logout)),
      main));
    if (PAGE_HEAD[state.view]) {
      const [title, sub] = PAGE_HEAD[state.view];
      main.append(h('div', { class: 'page-head' }, h('div', { class: 't' }, h('h1', {}, title), h('p', {}, sub))));
    }
    // Shown until the screen's data has arrived.
    const loading = h('div', { class: 'loading', role: 'status' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Loading…');
    main.append(loading);
    const view = { pipeline: pipelineView, opportunities: opportunitiesView, prospect: prospectView, portal: portalView, order: orderView,
      clients: clientsView, import: importView, compliance: complianceView }[state.view] || pipelineView;
    Promise.resolve(view(main)).catch((e) => main.append(h('div', { class: 'card empty' }, e.message))).finally(() => loading.remove());
    refreshPortalBadge();
  }

  function loginView() {
    const user = h('input', { id: 'admin-user', autocomplete: 'username', required: true });
    const pass = h('input', { id: 'admin-pass', type: 'password', autocomplete: 'current-password', required: true });
    const btn = h('button', { class: 'btn primary lg block', type: 'submit' }, 'Log in');
    return h('div', { class: 'login' }, h('form', { class: 'card', onsubmit: async (e) => {
      e.preventDefault();
      const ok = await act(btn, () => api('POST', '/api/login', { username: user.value, password: pass.value }));
      if (ok) boot();
    } }, h('span', { class: 'logo' }, SF.logoMark(), 'SiteForge'), h('h1', {}, 'Admin sign in'), h('p', {}, 'Prospecting, sites, clients and the client portal.'),
      h('label', { class: 'f' }, 'Username', user), h('label', { class: 'f' }, 'Password', pass), btn));
  }

  // ---------- pipeline ----------
  function scoreBadge(s) {
    if (s == null) return h('span', { class: 'score lo', title: 'Not audited' }, '–');
    return h('span', { class: 'score ' + (s >= 50 ? 'hi' : s >= 25 ? 'mid' : 'lo') }, s);
  }
  // Website status in plain words; the technical code stays in the tooltip.
  const WEBSITE_STATUS = {
    live: ['Works', 'good', 'The site loads (it may still have problems: see the score).'],
    none: ['No website', 'bad', 'No website is known for this business.'],
    'dns-dead': ['Domain expired', 'bad', 'The web address no longer works (DNS fails).'],
    'taken-over': ['Taken over', 'bad', 'The old address now shows someone else\'s (spam) site.'],
    parked: ['Parked page', 'bad', 'The domain shows a placeholder or "for sale" page.'],
    unreachable: ['Not loading', 'bad', 'The site did not answer.'],
    timeout: ['Not loading', 'bad', 'The site took too long to answer.'],
    'ssl-error': ['Security warning', 'bad', 'Browsers show a certificate warning.'],
    'invalid-url': ['Bad address', 'bad', 'The listed website is not a real web address.'],
    'social-only': ['Social page only', 'warn', 'Only a Facebook / Instagram / link page.'],
    blocked: ['Blocked our check', '', 'A firewall refused our automatic check. Look at it in a browser.'],
    'robots-blocked': ['Blocked our check', '', 'robots.txt asks us not to read the site.']
  };
  const statusBadge = (s) => {
    if (!s) return h('span', { class: 'badge plain', title: 'Not audited yet' }, 'Not checked');
    const [label, cls, why] = WEBSITE_STATUS[s] || (s.startsWith('http-') ? [`Error ${s.slice(5)}`, 'bad', `The site answers with HTTP ${s.slice(5)}.`] : [s, '', '']);
    return h('span', { class: 'badge ' + cls, title: `${why} (${s})` }, label);
  };
  const STAGE_LABEL = { discovered: 'Discovered', audited: 'Audited', generated: 'Site generated', contacted: 'Contacted', interested: 'Interested', won: 'Won', lost: 'Lost', dormant: 'Dormant' };
  const stageLabel = (s) => STAGE_LABEL[s] || s;
  const stageBadge = (s) => h('span', { class: 'badge ' + ({ won: 'good', interested: 'info', lost: 'bad', dormant: '' }[s] ?? 'info') }, stageLabel(s));

  async function pipelineView(main) {
    const f = state.filters;
    const statsBox = h('div', { class: 'stats' });
    const results = h('div');
    let seq = 0;
    let t;
    const search = h('input', { type: 'search', placeholder: 'Search by name or notes', value: f.q, 'aria-label': 'Search',
      oninput: () => { clearTimeout(t); t = setTimeout(() => { f.q = search.value; refresh(); }, 300); } });
    const sel = (key, opts, label) => h('select', { 'aria-label': label, onchange: (e) => { f[key] = e.target.value; refresh(); } },
      opts.map(([v, l]) => h('option', { value: v, selected: f[key] === v }, l)));
    const districtSel = sel('district', [['', 'All districts']], 'District');
    const queueBtn = h('button', { class: 'btn', title: 'Checks the website of every business that has no score yet, 4 at a time in the background' }, 'Audit unscored');
    queueBtn.onclick = () => act(queueBtn, () => api('POST', '/api/audit-queue', { limit: 500 }), (r) => `${r.queued} audits started. They run 4 at a time in the background.`);

    // Page actions sit next to the title; the row below holds only filters.
    main.querySelector('.page-head')?.append(h('div', { class: 'actions' }, queueBtn,
      h('button', { class: 'btn primary', onclick: addProspectDialog }, SF.icon('plus', 'sm'), 'Add prospect')));
    main.append(statsBox, h('div', { class: 'row filters' },
      search,
      sel('sector', [['', 'All sectors'], ...Object.entries(state.me.sectors)], 'Sector'),
      districtSel,
      sel('sort', [['score', 'Best prospects first'], ['updated', 'Recently updated'], ['created', 'Newest'], ['name', 'Name A–Z']], 'Sort'),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: f.hide_dnc === '1', onchange: (e) => { f.hide_dnc = e.target.checked ? '1' : ''; refresh(); } }), 'Hide do-not-contact')), results);

    // Only the counters and the table are redrawn; the search box and filters stay put.
    async function refresh() {
      const mine = ++seq;
      results.classList.add('busy');
      const [stats, list] = await Promise.all([
        api('GET', '/api/stats'),
        api('GET', '/api/prospects?' + new URLSearchParams(Object.entries(f).filter(([, v]) => v)))
      ]).catch((e) => { toast(e.message, true); return [null, null]; });
      if (mine !== seq) return; // a newer search has already started
      results.classList.remove('busy');
      if (!stats) return;

      const stat = (key, label, n) => h('button', { class: 'stat', 'aria-pressed': String(f.stage === key), onclick: () => { f.stage = key; refresh(); } }, h('b', {}, fmt(n)), h('span', {}, label));
      statsBox.replaceChildren(stat('', 'All prospects', stats.total), ...state.me.stages.map((s) => stat(s, stageLabel(s), stats.byStage[s])));
      queueBtn.textContent = `Audit unscored (${fmt(stats.unaudited)})`;
      queueBtn.disabled = !stats.unaudited;
      if (districtSel.options.length === 1) {
        districtSel.append(...list.districts.map((d) => h('option', { value: d, selected: f.district === d }, d)));
      }

      if (!list.rows.length) {
        results.replaceChildren(h('div', { class: 'card empty' }, stats.total ? 'No businesses match these filters.' : 'No businesses yet. Use Import to bring them in from OpenStreetMap or a CSV list, or press "Add prospect".'));
        return;
      }
      results.replaceChildren(h('div', { class: 'tablewrap' }, h('table', {},
        h('thead', {}, h('tr', {}, [['Score', 'How much they need a website (0–100)'], ['Business'], ['Sector'], ['District'], ['Website'], ['Stage'], ['Updated']].map(([c, title]) => h('th', { title }, c)))),
        h('tbody', {}, list.rows.map((p) => h('tr', { onclick: () => go('prospect', { prospectId: p.id, tab: 'overview' }) },
          h('td', {}, scoreBadge(p.score)),
          h('td', { class: 'name' }, p.name, p.do_not_contact ? [' ', h('span', { class: 'badge bad' }, 'do not contact')] : null),
          h('td', {}, state.me.sectors[p.sector] || p.sector),
          h('td', {}, p.district || ''),
          h('td', {}, statusBadge(p.website_status)),
          h('td', {}, stageBadge(p.stage)),
          h('td', { class: 'muted small' }, when(p.updated_at))))))),
        h('p', { class: 'muted small' }, `Showing ${fmt(list.rows.length)} of ${fmt(list.total)}${list.total > list.rows.length ? ' (the best 200; use the filters or search to find others)' : ''}.`));
    }
    await refresh();
  }

  // ---------- opportunities: who needs a new site, whose site needs updating ----------
  const INFO_LABELS = { phone: 'Phone', description: 'About', services: 'Services', hours: 'Hours', address: 'Address', email: 'Email' };
  const infoChips = (c) => (c ? h('span', { class: 'chips', title: `${c.percent}% of what a site needs` },
    Object.entries(INFO_LABELS).map(([k, l]) => h('span', { class: 'chip' + (c.have[k] ? ' on' : '') }, l))) : h('span', { class: 'muted small' }, 'not collected'));

  async function opportunitiesView(main) {
    const f = state.opp;
    const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v));
    const r = await api('GET', '/api/opportunities?' + qs).catch((e) => { toast(e.message, true); return null; });
    if (!r) return;

    const kindBtn = (k, label, hint) => h('button', { class: 'stat', 'aria-pressed': String(f.kind === k), onclick: () => { f.kind = k; render(); } },
      h('b', {}, fmt(r.counts[k])), h('span', {}, label), h('span', { class: 'hint' }, hint));
    main.append(h('div', { class: 'stats opp' },
      kindBtn('new', 'Build new', 'No website, or it is dead, parked or social-only'),
      kindBtn('update', 'Needs update', 'Site works but is outdated, insecure or not mobile-friendly'),
      kindBtn('check', 'Check by hand', 'Firewall or robots.txt kept us out')));

    const sel = (key, opts, label) => h('select', { 'aria-label': label, onchange: (e) => { f[key] = e.target.value; render(); } },
      opts.map(([v, l]) => h('option', { value: v, selected: f[key] === v }, l)));
    const n = Math.min(r.total, 500);
    const collectBtn = h('button', { class: 'btn primary', title: 'Reads each business\'s OpenStreetMap entry and its own website (respecting robots.txt), 2 at a time' },
      f.collected === '1' ? `Collect again (${fmt(n)})` : `Collect info for these (${fmt(n)})`);
    collectBtn.disabled = !n;
    collectBtn.onclick = () => act(collectBtn, () => api('POST', '/api/research-queue', { ...f, limit: 500 }),
      (x) => `${x.queued} queued. Runs in the background; refresh this page to see progress.`);
    const csv = h('a', { class: 'btn', href: '/api/opportunities.csv?' + qs, download: '' }, 'Download CSV');

    main.append(h('div', { class: 'row', style: 'margin-bottom:12px' },
      sel('sector', [['', 'All sectors'], ...Object.entries(state.me.sectors)], 'Sector'),
      sel('district', [['', 'All districts'], ...r.districts.map((d) => [d, d])], 'District'),
      sel('collected', [['', 'Collected or not'], ['0', 'Not collected yet'], ['1', 'Already collected']], 'Collected'),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: f.has_phone === '1', onchange: (e) => { f.has_phone = e.target.checked ? '1' : ''; render(); } }), 'Has a phone number'),
      h('span', { class: 'spacer' }),
      r.queued ? h('span', { class: 'badge info' }, `${fmt(r.queued)} collecting…`) : null,
      csv, collectBtn));

    if (!r.rows.length) {
      main.append(h('div', { class: 'card empty' }, 'Nothing here with these filters.'));
      return;
    }
    main.append(h('div', { class: 'tablewrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Score', 'Business', 'Sector', 'District', 'Why', 'Phone', 'Info collected'].map((c) => h('th', {}, c)))),
      h('tbody', {}, r.rows.map((p) => h('tr', { onclick: () => go('prospect', { prospectId: p.id, tab: 'problems' }) },
        h('td', {}, scoreBadge(p.score)),
        h('td', { class: 'name' }, p.name, p.website_url ? h('div', { class: 'small muted mono clip' }, p.website_url) : null),
        h('td', {}, state.me.sectors[p.sector] || p.sector),
        h('td', {}, p.district || ''),
        h('td', { class: 'why' }, p.reasons.map((x) => h('div', {}, x))),
        h('td', { class: 'small' }, p.phone || h('span', { class: 'muted' }, '–')),
        h('td', {}, infoChips(p.completeness))))))));
    main.append(h('p', { class: 'muted small' }, `Showing ${r.rows.length} of ${fmt(r.total)}. Clients and do-not-contact businesses are left out.`));
  }

  function researchCard(d, reload) {
    const p = d.prospect;
    const r = d.research;
    const label = r ? 'Collect again' : 'Collect info';
    const btn = h('button', { class: 'btn primary' }, label);
    btn.onclick = async () => {
      btn.textContent = 'Collecting…';
      const x = await act(btn, () => api('POST', `/api/prospects/${p.id}/research`, {}), (y) => `Collected ${y.completeness.percent}% of what a site needs`);
      btn.textContent = label;
      if (x) reload();
    };
    const f = r?.found || {};
    const item = (name, val) => (val && (!Array.isArray(val) || val.length)
      ? [h('dt', {}, name), h('dd', {}, Array.isArray(val) ? val.map((v) => h('div', {}, v)) : val)] : null);
    const socials = Object.entries(f.socials || {}).map(([k, u]) => h('a', { href: u, target: '_blank', rel: 'noopener noreferrer', class: 'badge info' }, k));
    return h('div', { class: 'card stack' },
      h('div', { class: 'row' }, h('h2', { style: 'margin:0' }, 'Collected info'), h('span', { class: 'spacer' }), btn),
      r ? [
        h('div', { class: 'row' }, infoChips(r.completeness), h('span', { class: 'muted small' }, when(r.collected_at))),
        h('dl', { class: 'kv' },
          item('Description', f.description), item('About', f.about), item('Facts', f.facts), item('Services', f.services),
          item('Hours', f.hours), item('Address', f.address), item('Phones', f.phones), item('Emails', f.emails),
          socials.length ? [h('dt', {}, 'Social'), h('dd', { class: 'row' }, socials)] : null),
        f.dropped_emails?.length ? h('p', { class: 'badge warn' }, `Left out ${f.dropped_emails.join(', ')}: the domain has expired, so mail to it bounces.`) : null,
        h('p', { class: 'muted small' }, d.sites.length
          ? 'A site was already generated, so the brief keeps what was used then. Copy anything new from here into the brief on the Site tab.'
          : 'The brief on the Site tab is pre-filled from this. Check it: headings from an old site are not always real services.'),
        h('div', { class: 'small muted' }, 'Sources: ', r.sources.length
          ? r.sources.map((s, i) => [i ? ' · ' : '', s.name, ' ', h('span', { class: 'badge ' + (s.ok ? 'good' : 'bad') }, s.note || (s.ok ? 'ok' : 'failed'))])
          : 'none available')
      ] : h('p', { class: 'muted' }, 'Reads this business\'s OpenStreetMap entry and its own website (if it still works) for a description, services, hours, address, phones and emails, to fill the site brief.'));
  }

  // ---------- problems: what is wrong, what it costs them, and a message about it ----------
  const SEVERITY_BADGE = { critical: ['Critical', 'bad'], high: ['Serious', 'warn'], medium: ['Worth fixing', ''] };
  const SERVICE_LABEL = { 'new-website': 'New business website', 'website-update': 'Website update or redesign', 'domain-email': '.rw domain and business email', hosting: 'Hosting and monthly updates' };

  async function problemsTab(panel, d, reload) {
    const p = d.prospect;
    let r;
    try { r = await api('GET', `/api/prospects/${p.id}/problems`); } catch (e) { panel.append(h('div', { class: 'card empty' }, e.message)); return; }

    const warnings = r.warnings.length ? h('div', { class: 'stack', style: 'gap:8px' }, r.warnings.map((w) =>
      h('div', { class: 'card row', style: 'padding:10px 14px' }, h('span', { class: 'badge warn' }, 'Check first'), h('span', { class: 'small' }, w)))) : null;

    if (r.unchecked) {
      panel.append(h('div', { class: 'card empty' }, r.unchecked));
      return;
    }
    if (!r.issues.length) {
      panel.append(h('div', { class: 'card empty' }, 'No problems found in the last audit. Their website looks healthy, so there is nothing to offer them here.'));
      return;
    }

    const counts = r.issues.reduce((a, x) => ({ ...a, [x.severity]: (a[x.severity] || 0) + 1 }), {});
    const summary = h('div', { class: 'row' },
      h('h2', { style: 'margin:0' }, `${r.issues.length} problem${r.issues.length > 1 ? 's' : ''} found`),
      Object.entries(SEVERITY_BADGE).filter(([k]) => counts[k]).map(([k, [label, cls]]) => h('span', { class: 'badge ' + cls }, `${counts[k]} ${label.toLowerCase()}`)),
      h('span', { class: 'spacer' }), h('span', { class: 'small muted' }, `From the audit of ${when(r.checked_at)}`));

    const list = h('div', { class: 'stack', style: 'gap:10px' }, r.issues.map((x) => h('div', { class: 'card problem sev-' + x.severity },
      h('div', { class: 'row' }, h('span', { class: 'badge ' + SEVERITY_BADGE[x.severity][1] }, SEVERITY_BADGE[x.severity][0]), h('h3', { style: 'margin:0' }, x.problem)),
      h('dl', { class: 'kv' },
        h('dt', {}, 'What it costs them'), h('dd', {}, x.consequence),
        h('dt', {}, 'What fixes it'), h('dd', {}, x.fix, SERVICE_LABEL[x.service] ? h('span', { class: 'small muted' }, ` · service: ${SERVICE_LABEL[x.service]}`) : null),
        x.evidence ? [h('dt', {}, 'Evidence'), h('dd', { class: 'small mono' }, x.evidence)] : null))));

    panel.append(h('div', { class: 'cols wide-left' },
      h('div', { class: 'stack' }, summary, warnings, list),
      h('div', { class: 'stack' }, contactCard(p, r, d, reload))));
  }

  function contactCard(p, r, d, reload) {
    if (r.do_not_contact) {
      return h('div', { class: 'card stack' }, h('h2', { style: 'margin:0' }, 'Do not contact'),
        h('p', {}, 'This business asked not to be contacted. You can read the problems, but no message can be sent.'));
    }
    const c = r.contacts;
    const last = d.outreach.find((o) => o.channel !== 'note');
    const lang = state.lang === 'rw' ? 'rw' : 'en';
    const m = r.messages[lang];
    const subject = h('input', { value: m.subject, 'aria-label': 'Email subject' });
    const body = h('textarea', { rows: 14, 'aria-label': 'Message' }, m.body);
    const text = () => `${body.value.trim()}\n\n${m.stop}`;
    const langBtn = (l, label) => h('button', { class: 'btn', 'aria-pressed': String(lang === l), onclick: () => { state.lang = l; reload(); } }, label);

    // Opening WhatsApp or the email app doesn't send anything; the admin presses send there, then logs it here.
    const logRow = h('div', { class: 'row', hidden: true });
    const offerLog = (channel) => {
      const btn = h('button', { class: 'btn primary' }, `Yes, I sent it on ${channel === 'whatsapp' ? 'WhatsApp' : 'email'}: log it`);
      btn.onclick = async () => {
        const ok = await act(btn, () => api('POST', `/api/prospects/${p.id}/outreach`, { channel, message: channel === 'email' ? `${subject.value}\n\n${text()}` : text(), outcome: 'Sent problem report' }), 'Logged on the Outreach tab');
        if (ok) reload();
      };
      logRow.replaceChildren(h('span', { class: 'small muted' }, 'Did you send it?'), btn);
      logRow.hidden = false;
    };
    const wa = h('button', { class: 'btn primary', disabled: !c.whatsapp, title: c.whatsapp ? `Opens WhatsApp to ${c.phone}` : 'No phone number on file' }, 'Open in WhatsApp');
    wa.onclick = () => { window.open(`https://wa.me/${c.whatsapp}?text=${encodeURIComponent(text())}`, '_blank', 'noopener'); offerLog('whatsapp'); };
    const mail = h('button', { class: 'btn primary', disabled: !c.email, title: c.email ? `Opens your email app to ${c.email}` : 'No working email on file' }, 'Open in email');
    mail.onclick = () => { location.href = `mailto:${c.email}?subject=${encodeURIComponent(subject.value)}&body=${encodeURIComponent(text())}`; offerLog('email'); };
    const copy = h('button', { class: 'btn' }, 'Copy');
    copy.onclick = () => navigator.clipboard.writeText(text()).then(() => toast('Copied'), () => toast('Copy failed', true));

    return h('div', { class: 'card stack' },
      h('div', { class: 'row' }, h('h2', { style: 'margin:0' }, 'Contact them about it'), h('span', { class: 'spacer' }), langBtn('en', 'English'), langBtn('rw', 'Kinyarwanda')),
      h('dl', { class: 'kv' },
        h('dt', {}, 'WhatsApp'), h('dd', {}, c.whatsapp ? c.phone : h('span', { class: 'muted' }, 'no phone number')),
        h('dt', {}, 'Email'), h('dd', {}, c.email || h('span', { class: 'muted' }, 'no working email')),
        h('dt', {}, 'Last contact'), h('dd', {}, last ? `${last.channel} · ${when(last.sent_at)}${last.outcome ? ` · ${last.outcome}` : ''}` : 'never')),
      h('label', { class: 'f' }, 'Email subject', subject),
      h('label', { class: 'f' }, 'Message (edit it before sending)', body),
      h('div', { class: 'small muted' }, 'Always added at the end: ', h('span', { class: 'mono' }, m.stop)),
      h('div', { class: 'row' }, wa, mail, copy),
      logRow,
      h('p', { class: 'small muted' }, lang === 'rw' ? 'Read the Kinyarwanda text before sending and correct anything that sounds unnatural.' : 'Sent messages are logged on the Outreach tab. If they ask you to stop, press "They asked us to stop" there.'));
  }

  function addProspectDialog() {
    const name = h('input', { required: true });
    const sector = h('select', {}, Object.entries(state.me.sectors).map(([k, l]) => h('option', { value: k, selected: k === 'generic' }, l)));
    const district = h('input', { placeholder: 'Gasabo, Kicukiro, Nyarugenge…' });
    const website = h('input', { placeholder: 'example.rw or leave empty' });
    const phone = h('input', { placeholder: '07…' });
    const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Add');
    const dlg = h('dialog', {}, h('form', { class: 'stack', onsubmit: async (e) => {
      e.preventDefault();
      const r = await act(btn, () => api('POST', '/api/prospects', { name: name.value, sector: sector.value, district: district.value, website_url: website.value, contact_phone: phone.value, contact_source: 'visit' }));
      if (r) { dlg.close(); dlg.remove(); r.id ? go('prospect', { prospectId: r.id, tab: 'overview' }) : render(); }
    } }, h('h2', {}, 'Add prospect'), h('label', { class: 'f' }, 'Business name', name), h('label', { class: 'f' }, 'Sector', sector),
      h('label', { class: 'f' }, 'District', district), h('label', { class: 'f' }, 'Website', website), h('label', { class: 'f' }, 'Business phone', phone),
      h('div', { class: 'row' }, h('span', { class: 'spacer' }), h('button', { class: 'btn', type: 'button', onclick: () => { dlg.close(); dlg.remove(); } }, 'Cancel'), btn)));
    document.body.append(dlg);
    dlg.showModal();
  }

  // ---------- prospect detail ----------
  async function prospectView(main) {
    let d;
    try { d = await api('GET', `/api/prospects/${state.prospectId}`); } catch (e) { main.append(h('div', { class: 'card empty' }, e.message)); return; }
    const p = d.prospect;
    const reload = () => render();

    const stageSel = h('select', { 'aria-label': 'Stage', title: 'Where this business is in your sales process',
      onchange: async (e) => { if (await act(null, () => api('PATCH', `/api/prospects/${p.id}`, { stage: e.target.value }), `Stage: ${stageLabel(e.target.value)}`)) reload(); else e.target.value = p.stage; } },
      state.me.stages.map((s) => h('option', { value: s, selected: p.stage === s }, stageLabel(s))));
    const BACK = { pipeline: 'Pipeline', opportunities: 'Opportunities', clients: 'Hosting clients', compliance: 'Compliance' };
    const backTo = BACK[state.backTo] ? state.backTo : 'pipeline';
    const site = p.website_url ? (/^https?:\/\//i.test(p.website_url) ? p.website_url : `https://${p.website_url}`) : null;
    main.append(
      h('button', { class: 'btn back', onclick: () => go(backTo) }, SF.icon('arrowLeft', 'sm'), BACK[backTo]),
      h('div', { class: 'detail-head' }, scoreBadge(p.score), h('h1', {}, p.name), statusBadge(p.website_status),
        h('label', { class: 'check stage-pick' }, h('span', { class: 'small muted' }, 'Stage'), stageSel),
        p.do_not_contact ? h('span', { class: 'badge bad' }, 'Do not contact') : null),
      h('p', { class: 'detail-sub' }, [state.me.sectors[p.sector] || p.sector, p.district, p.sector_admin].filter(Boolean).join(' · '),
        site ? [' · ', h('a', { href: site, target: '_blank', rel: 'noopener noreferrer' }, p.website_url)] : ' · no website known'));

    const TABS = [['overview', 'Overview'], ['problems', 'Problems'], ['google', 'Google'], ['site', 'Site'], ['outreach', 'Outreach'], ['client', d.client ? 'Hosting client' : 'Make hosting client'], ['data', 'Data']];
    main.append(h('div', { class: 'tabs', role: 'tablist' }, TABS.map(([k, l]) =>
      h('button', { role: 'tab', 'aria-selected': String(state.tab === k), onclick: () => go('prospect', { tab: k }) }, l))));
    const panel = h('div', { role: 'tabpanel' });
    main.append(panel);
    ({ overview: overviewTab, problems: problemsTab, google: googleTab, site: siteTab, outreach: outreachTab, client: clientTab, data: dataTab })[state.tab](panel, d, reload);
  }

  function overviewTab(panel, d, reload) {
    const p = d.prospect;
    const fields = {};
    const input = (k, label, attrs = {}) => h('label', { class: 'f' }, label, fields[k] = h('input', { value: p[k] ?? '', ...attrs }));
    fields.sector = h('select', {}, Object.entries(state.me.sectors).map(([k, l]) => h('option', { value: k, selected: p.sector === k }, l)));
    fields.notes = h('textarea', { rows: 5 }, p.notes || '');
    const save = h('button', { class: 'btn primary', type: 'submit' }, 'Save');
    const form = h('form', { class: 'card stack', onsubmit: async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(Object.entries(fields).map(([k, el]) => [k, el.value]));
      if (await act(save, () => api('PATCH', `/api/prospects/${p.id}`, body), 'Saved')) reload();
    } },
      h('h2', {}, 'Details'),
      h('div', { class: 'grid2' }, input('name', 'Name'), h('label', { class: 'f' }, 'Sector', fields.sector), input('district', 'District'),
        input('sector_admin', 'Sector (umurenge)'), input('website_url', 'Website'), input('contact_phone', 'Business phone'),
        input('contact_email', 'Business email'), input('contact_source', 'Contact source')),
      h('p', { class: 'muted small' }, 'Prefer a general business phone or email over a named person\'s mobile. Do not copy details from Google here: fetch them live on the Google tab.'),
      h('label', { class: 'f' }, 'Notes', fields.notes),
      h('div', { class: 'row' }, save));

    const auditBtn = h('button', { class: 'btn primary' }, p.score == null ? 'Run audit' : 'Re-audit');
    auditBtn.onclick = async () => { if (await act(auditBtn, () => api('POST', `/api/prospects/${p.id}/audit`, {}), (r) => `Score ${r.score} (${r.website_status})`)) reload(); };

    const b = p.score_breakdown;
    const scoreCard = h('div', { class: 'card stack' },
      h('div', { class: 'row' }, h('h2', { style: 'margin:0' }, 'Website score'), h('span', { class: 'spacer' }), auditBtn),
      b ? [
        h('p', { class: 'small' }, `${b.raw} points for the problems below × ${b.wtp} for this sector (how likely this kind of business is to pay) = score `, h('b', {}, String(b.score)), '.'),
        b.breakdown.length ? h('div', { class: 'stack', style: 'gap:8px' }, b.breakdown.map((x) => h('div', { class: 'bar' },
          h('span', {}, x.label), h('b', {}, `+${x.points}`), h('div', { class: 'track' }, h('div', { class: 'fill', style: `width:${Math.min(100, x.points * 2.5)}%` }))))) : h('p', { class: 'muted' }, 'No problems found: the site looks healthy.')
      ] : h('p', { class: 'muted' }, 'Not audited yet.'));

    const audits = h('div', { class: 'card' }, h('h2', {}, 'Audit history'),
      d.audits.length ? h('ul', { class: 'list' }, d.audits.map((a) => h('li', {},
        h('div', { class: 'row' }, h('b', {}, `Score ${a.score}`), h('span', { class: 'muted small' }, when(a.checked_at)), h('span', { class: 'spacer' }),
          a.http_status ? h('span', { class: 'badge' }, `HTTP ${a.http_status}`) : null, a.load_ms != null ? h('span', { class: 'badge' }, `${a.load_ms} ms`) : null,
          a.cms_detected ? h('span', { class: 'badge' }, a.cms_detected) : null),
        a.final_url ? h('div', { class: 'small mono' }, a.final_url) : null,
        a.signals?.website_source ? h('div', { class: 'small muted' }, `Website address from: ${({ osm: 'OpenStreetMap', rdb: 'RDB list', csv: 'your CSV list', visit: 'you (visit)', manual: 'you', google: 'Google', 'none-recorded': 'nowhere (no website known)' })[a.signals.website_source] || a.signals.website_source}`) : null,
        (a.signals?.notes || []).map((n) => h('div', { class: 'small muted' }, n))))) : h('p', { class: 'muted' }, 'None yet.'));

    panel.append(h('div', { class: 'cols' }, h('div', { class: 'stack' }, form, researchCard(d, reload)), h('div', { class: 'stack' }, scoreCard, audits)));
  }

  function googleTab(panel, d, reload) {
    const p = d.prospect;
    const out = h('div', { class: 'stack' });
    const btn = h('button', { class: 'btn primary', disabled: !state.me.features.places }, p.place_id ? 'Fetch live details' : 'Find on Google');
    const link = async (placeId, b) => { if (await act(b, () => api('POST', `/api/prospects/${p.id}/places`, { place_id: placeId }), placeId ? 'Linked' : 'Unlinked')) reload(); };
    btn.onclick = async () => {
      const r = await act(btn, () => api('GET', `/api/prospects/${p.id}/places`));
      if (!r) return;
      out.replaceChildren();
      if (r.details) {
        const x = r.details;
        const unlink = h('button', { class: 'btn danger' }, 'Unlink');
        unlink.onclick = () => link(null, unlink);
        out.append(h('div', { class: 'card' },
          h('dl', { class: 'kv' },
            h('dt', {}, 'Name'), h('dd', {}, x.name || ''), h('dt', {}, 'Address'), h('dd', {}, x.address || ''),
            h('dt', {}, 'Phone'), h('dd', {}, x.phone || '–'), h('dt', {}, 'Website'), h('dd', {}, x.website ? h('a', { href: x.website, target: '_blank', rel: 'noopener noreferrer' }, x.website) : 'none listed'),
            h('dt', {}, 'Rating'), h('dd', {}, x.rating ? `${x.rating} (${x.ratings})` : '–'), h('dt', {}, 'Status'), h('dd', {}, x.status || ''),
            h('dt', {}, 'Hours'), h('dd', {}, x.hours.length ? x.hours.map((l) => h('div', {}, l)) : '–')),
          h('div', { class: 'row', style: 'margin-top:12px' }, x.maps_url ? h('a', { class: 'btn', href: x.maps_url, target: '_blank', rel: 'noopener noreferrer' }, 'Open in Google Maps') : null, unlink),
          h('p', { class: 'attrib' }, x.attribution, ' · Shown live, not saved.')));
      } else if (r.candidates.length) {
        out.append(h('div', { class: 'card' }, h('h2', {}, 'Which one is it?'), h('ul', { class: 'list' }, r.candidates.map((c) => {
          const b = h('button', { class: 'btn' }, 'This one');
          b.onclick = () => link(c.place_id, b);
          return h('li', { class: 'row' }, h('div', {}, h('b', {}, c.name), h('div', { class: 'small muted' }, c.address)), h('span', { class: 'spacer' }), b);
        })), h('p', { class: 'attrib' }, 'Data © Google')));
      } else out.append(h('div', { class: 'card empty' }, 'No match on Google.'));
    };
    panel.append(h('div', { class: 'card stack' },
      h('h2', {}, 'Google Places (live lookup)'),
      h('p', { class: 'muted' }, 'Google\'s terms allow storing only the place ID (and coordinates for 30 days). Everything shown here is fetched fresh each time and never saved.'),
      state.me.features.places ? null : h('p', { class: 'badge warn' }, 'Set GOOGLE_PLACES_API_KEY in .env to enable.'),
      h('div', { class: 'row' }, btn, p.place_id ? h('span', { class: 'small mono muted' }, p.place_id) : null)), out);
  }

  function siteTab(panel, d, reload) {
    const p = d.prospect;
    const b = d.brief;
    const selected = [...(b.photos || [])].filter((x) => d.photos.includes(x));
    const f = {};
    const inp = (k, label, val, attrs = {}) => h('label', { class: 'f' }, label, f[k] = h('input', { value: val ?? '', ...attrs }));
    const area = (k, label, val, ph) => h('label', { class: 'f' }, label, f[k] = h('textarea', { rows: 4, placeholder: ph }, (val || []).join('\n')));
    f.template = h('select', {}, Object.entries(state.me.templates).map(([k, l]) => h('option', { value: k, selected: b.template === k }, l)));
    const briefBody = () => ({
      template: f.template.value, languages: f.languages.value.split(/[\s,]+/).filter(Boolean),
      business_name: f.business_name.value, services: f.services.value, facts: f.facts.value, hours: f.hours.value,
      phone: f.phone.value, whatsapp: f.whatsapp.value, email: f.email.value, address: f.address.value, area: f.area.value,
      district: f.district.value, tone: f.tone.value, photos: selected
    });

    // photos
    const photoGrid = h('div', { class: 'photos' });
    const drawPhotos = () => {
      photoGrid.replaceChildren(...d.photos.map((name) => {
        const i = selected.indexOf(name);
        const del = h('button', { class: 'x', title: 'Delete photo', 'aria-label': 'Delete photo' }, '×');
        del.onclick = async (e) => {
          e.stopPropagation();
          if (!confirm('Delete this photo?')) return;
          if (await act(del, () => api('DELETE', `/api/prospects/${p.id}/photos/${encodeURIComponent(name)}`))) reload();
        };
        return h('div', { class: 'photo' + (i >= 0 ? ' on' : '') },
          h('img', { src: `/api/prospects/${p.id}/photos/${encodeURIComponent(name)}`, alt: name, title: 'Click to use / order on the site', onclick: () => {
            if (i >= 0) selected.splice(i, 1); else selected.push(name);
            drawPhotos();
          } }),
          i >= 0 ? h('span', { class: 'n' }, i === 0 ? 'hero' : i + 1) : null, del);
      }));
    };
    drawPhotos();
    const upload = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', multiple: true });
    upload.onchange = async () => {
      for (const file of upload.files) {
        const data = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
        const r = await act(null, () => api('POST', `/api/prospects/${p.id}/photos`, { name: file.name, data }));
        if (r) { d.photos.push(r.name); selected.push(r.name); }
      }
      upload.value = '';
      drawPhotos();
    };

    const genBtn = h('button', { class: 'btn primary', type: 'submit' }, state.me.features.ai ? 'Generate with Claude' : 'Generate (placeholder copy)');
    const briefForm = h('form', { class: 'card stack', onsubmit: async (e) => {
      e.preventDefault();
      genBtn.textContent = 'Generating…';
      const r = await act(genBtn, () => api('POST', `/api/prospects/${p.id}/generate`, { brief: briefBody() }), (s) => `Version ${s.version} ready`);
      genBtn.textContent = state.me.features.ai ? 'Generate with Claude' : 'Generate (placeholder copy)';
      if (r) { state.previewSite = r.id; reload(); }
    } },
      h('h2', {}, 'Brief'),
      h('p', { class: 'muted small' }, 'Only what is written here can appear on the site. Claude is told not to invent prices, awards or years in business, but read every version before you approve it.'),
      h('div', { class: 'grid2' },
        h('label', { class: 'f' }, 'Design', f.template),
        inp('languages', 'Languages, first = main (rw, en, fr)', b.languages.join(', ')),
        inp('business_name', 'Business name', b.business_name),
        inp('phone', 'Phone', b.phone), inp('whatsapp', 'WhatsApp number', b.whatsapp), inp('email', 'Email', b.email),
        inp('address', 'Street / landmark', b.address), inp('area', 'Area (umurenge)', b.area), inp('district', 'District', b.district)),
      area('services', 'Services (one per line)', b.services, 'Rooms\nConference hall\nAirport pickup'),
      area('facts', 'Facts the owner confirmed (one per line)', b.facts, 'Open since 2015\nFree Wi-Fi'),
      area('hours', 'Opening hours (one per line)', b.hours, 'Mon–Fri: 8:00–18:00\nSat: 9:00–14:00'),
      inp('tone', 'Tone', b.tone),
      h('h3', {}, 'Photos'),
      h('p', { class: 'muted small' }, 'Your own photos of the shopfront and team close far better than stock images. Click photos to choose them; the first one is the hero.'),
      upload, photoGrid,
      h('div', { class: 'row' }, genBtn));

    // versions + preview
    const current = d.sites.find((s) => s.id === state.previewSite) || d.sites[0];
    const versions = h('div', { class: 'card stack' }, h('h2', { style: 'margin:0' }, 'Versions'),
      d.sites.length ? h('ul', { class: 'list' }, d.sites.map((s) => {
        const approve = h('button', { class: 'btn' }, 'Approve');
        approve.onclick = async () => { if (await act(approve, () => api('POST', `/api/sites/${s.id}/approve`, {}), 'Approved')) reload(); };
        const deploy = h('button', { class: 'btn primary' }, state.me.features.vercel ? 'Deploy to Vercel' : 'Publish locally');
        deploy.onclick = async () => { if (await act(deploy, () => api('POST', `/api/sites/${s.id}/deploy`, {}), (r) => `Live: ${r.url}`)) reload(); };
        return h('li', {},
          h('div', { class: 'row' },
            h('b', {}, `v${s.version}`), h('span', { class: 'badge ' + (s.content_source === 'fallback' ? 'warn' : '') }, s.content_source),
            h('span', { class: 'muted small' }, when(s.generated_at)), h('span', { class: 'spacer' }),
            s.approved_by_admin ? h('span', { class: 'badge good' }, `approved by ${s.approved_by_admin}`) : null,
            s.deploy_id ? h('span', { class: 'badge info' }, 'deployed') : null),
          h('div', { class: 'row', style: 'margin-top:6px' },
            h('button', { class: 'btn', onclick: () => { state.previewSite = s.id; reload(); } }, current && current.id === s.id ? 'Showing' : 'Preview'),
            h('a', { class: 'btn', href: s.preview_url, target: '_blank', rel: 'noopener' }, 'Open'),
            s.approved_by_admin ? deploy : approve));
      })) : h('p', { class: 'muted' }, 'Nothing generated yet. Fill in the brief and press Generate.'));

    const previewCard = current ? h('div', { class: 'card' },
      h('div', { class: 'framebar' }, h('b', {}, `Preview v${current.version}`), h('span', { class: 'spacer' }),
        h('button', { class: 'btn', 'aria-pressed': String(!state.frameMobile), onclick: () => { state.frameMobile = false; reload(); } }, 'Desktop'),
        h('button', { class: 'btn', 'aria-pressed': String(state.frameMobile), onclick: () => { state.frameMobile = true; reload(); } }, 'Phone')),
      h('iframe', { class: 'frame' + (state.frameMobile ? ' mobile' : ''), src: new URL(current.preview_url).pathname, title: 'Site preview', sandbox: 'allow-same-origin allow-popups' })) : null;

    // hand edit of the latest copy
    let editor = null;
    if (d.content) {
      const ta = h('textarea', { rows: 18, class: 'mono', spellcheck: 'false' }, JSON.stringify(d.content, null, 2));
      const saveBtn = h('button', { class: 'btn primary' }, 'Save as new version');
      saveBtn.onclick = async () => {
        let content;
        try { content = JSON.parse(ta.value); } catch (e) { toast('That is not valid JSON.', true); return; }
        const r = await act(saveBtn, () => api('POST', `/api/prospects/${p.id}/generate`, { content, brief: briefBody() }), (s) => `Version ${s.version} saved`);
        if (r) { state.previewSite = r.id; reload(); }
      };
      editor = h('details', { class: 'card' }, h('summary', {}, 'Edit the copy by hand'),
        h('p', { class: 'muted small' }, 'Fix wording, a wrong service or a Kinyarwanda phrase here. Length limits still apply.'), ta, h('div', { class: 'row', style: 'margin-top:8px' }, saveBtn));
    }

    panel.append(h('div', { class: 'cols' }, h('div', { class: 'stack' }, briefForm, editor), h('div', { class: 'stack' }, versions, previewCard)));
  }

  async function outreachTab(panel, d, reload) {
    const p = d.prospect;
    if (p.do_not_contact) {
      panel.append(h('div', { class: 'card' }, h('h2', {}, 'Do not contact'), h('p', {}, 'This business asked not to be contacted. Outreach is blocked and cannot be switched back on.')),
        logList(d.outreach));
      return;
    }
    let msg = null;
    try { msg = await api('GET', `/api/prospects/${p.id}/message?lang=${state.lang}`); } catch (e) { toast(e.message, true); }
    const langBtn = (l, label) => h('button', { class: 'btn', 'aria-pressed': String(state.lang === l), onclick: () => { state.lang = l; reload(); } }, label);
    const copy = h('button', { class: 'btn' }, 'Copy');
    copy.onclick = () => navigator.clipboard.writeText(msg.full).then(() => toast('Copied'), () => toast('Copy failed', true));

    const channel = h('select', {}, ['visit', 'call', 'whatsapp', 'sms', 'email'].map((c) => h('option', { value: c }, c)));
    const outcome = h('input', { placeholder: 'e.g. Owner liked it, call back Friday' });
    const text = h('textarea', { rows: 3, placeholder: 'Message sent (for WhatsApp / SMS / email)' });
    const logBtn = h('button', { class: 'btn primary', type: 'submit' }, 'Log contact');
    const optBtn = h('button', { class: 'btn danger', type: 'button' }, 'They asked us to stop');
    optBtn.onclick = async () => {
      if (!confirm('Mark as do-not-contact? This is permanent.')) return;
      if (await act(optBtn, () => api('POST', `/api/prospects/${p.id}/opt-out`, {}), 'Marked do-not-contact')) reload();
    };

    panel.append(h('div', { class: 'cols' },
      h('div', { class: 'card stack' },
        h('div', { class: 'row' }, h('h2', { style: 'margin:0' }, 'Message'), h('span', { class: 'spacer' }), langBtn('rw', 'Kinyarwanda'), langBtn('en', 'English')),
        msg ? [h('div', { class: 'msg' }, msg.full),
          h('div', { class: 'row' }, copy, msg.whatsapp ? h('a', { class: 'btn primary', href: msg.whatsapp, target: '_blank', rel: 'noopener' }, 'Open in WhatsApp') : h('span', { class: 'muted small' }, 'No usable phone number for WhatsApp.'))] : null,
        h('p', { class: 'muted small' }, 'The stop line is required by the ICT law in every marketing message and is always added. Walking in with the preview on your phone converts best.')),
      h('form', { class: 'card stack', onsubmit: async (e) => {
        e.preventDefault();
        if (await act(logBtn, () => api('POST', `/api/prospects/${p.id}/outreach`, { channel: channel.value, outcome: outcome.value, message: text.value }), 'Logged')) reload();
      } }, h('h2', {}, 'Log a contact'), h('div', { class: 'grid2' }, h('label', { class: 'f' }, 'Channel', channel), h('label', { class: 'f' }, 'Outcome', outcome)),
        h('label', { class: 'f' }, 'Message', text), h('div', { class: 'row' }, logBtn, h('span', { class: 'spacer' }), optBtn))),
    logList(d.outreach));
  }

  function logList(rows) {
    return h('div', { class: 'card', style: 'margin-top:16px' }, h('h2', {}, 'History'),
      rows.length ? h('ul', { class: 'list' }, rows.map((o) => h('li', {},
        h('div', { class: 'row' }, h('span', { class: 'badge' }, o.channel), h('span', { class: 'muted small' }, when(o.sent_at)), o.opt_out_at ? h('span', { class: 'badge bad' }, 'opt-out') : null),
        o.outcome ? h('div', {}, o.outcome) : null, o.message ? h('div', { class: 'small muted', style: 'white-space:pre-wrap' }, o.message) : null))) : h('p', { class: 'muted' }, 'No contact yet.'));
  }

  async function clientTab(panel, d, reload) {
    const p = d.prospect, c = d.client;
    if (!c) {
      const f = { contact_name: h('input'), phone: h('input', { value: p.contact_phone || '' }), setup_fee: h('input', { type: 'number', min: 0, value: 250000 }),
        monthly_fee: h('input', { type: 'number', min: 0, value: 15000 }), plan: h('select', {}, h('option', { value: 'monthly' }, 'Monthly'), h('option', { value: 'annual' }, 'Annual')) };
      const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Create client');
      panel.append(h('form', { class: 'card stack', onsubmit: async (e) => {
        e.preventDefault();
        if (await act(btn, () => api('POST', `/api/prospects/${p.id}/client`, Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.value]))), 'Client created')) reload();
      } }, h('h2', {}, 'They said yes: make them a hosting client'),
        h('p', { class: 'muted small' }, 'For businesses you host and bill every month. Orders placed in the client portal are handled under Client portal instead.'),
        h('div', { class: 'grid2' }, h('label', { class: 'f' }, 'Contact person', f.contact_name), h('label', { class: 'f' }, 'Phone', f.phone),
          h('label', { class: 'f' }, 'Setup fee (RWF)', f.setup_fee), h('label', { class: 'f' }, 'Monthly fee (RWF)', f.monthly_fee), h('label', { class: 'f' }, 'Plan', f.plan)),
        h('p', { class: 'muted small' }, 'Put in the contract what happens if they leave: whether they get an HTML export of the site or not.'),
        h('div', { class: 'row' }, btn)));
      return;
    }
    const pays = await api('GET', `/api/clients/${c.id}/payments`).catch(() => ({ rows: [] }));
    const amount = h('input', { type: 'number', min: 1, value: c.plan === 'annual' ? c.monthly_fee * 12 : c.monthly_fee });
    const txid = h('input', { placeholder: 'MoMo transaction ID' });
    const months = h('input', { type: 'number', min: 1, max: 36, value: c.plan === 'annual' ? 12 : 1 });
    const payBtn = h('button', { class: 'btn primary', type: 'submit' }, 'Record payment');
    const domain = h('input', { value: c.domain || '', placeholder: 'business.rw' });
    const domBtn = h('button', { class: 'btn', type: 'submit' }, 'Save domain');
    const statusBadgeC = h('span', { class: 'badge ' + ({ active: 'good', overdue: 'warn', suspended: 'bad', cancelled: '' }[c.status]) }, c.status);

    panel.append(h('div', { class: 'cols' },
      h('div', { class: 'stack' },
        h('div', { class: 'card' }, h('div', { class: 'row' }, h('h2', { style: 'margin:0' }, c.business_name), statusBadgeC),
          h('dl', { class: 'kv', style: 'margin-top:12px' },
            h('dt', {}, 'Contact'), h('dd', {}, [c.contact_name, c.phone].filter(Boolean).join(' · ') || '–'),
            h('dt', {}, 'Plan'), h('dd', {}, `${c.plan}, ${rwf(c.monthly_fee)}/month, setup ${rwf(c.setup_fee)}`),
            h('dt', {}, 'Paid until'), h('dd', {}, c.next_invoice_at),
            h('dt', {}, 'Live at'), h('dd', {}, c.live_url ? h('a', { href: c.live_url, target: '_blank', rel: 'noopener' }, c.live_url) : 'not deployed yet'))),
        h('form', { class: 'card stack', onsubmit: async (e) => {
          e.preventDefault();
          const r = await act(domBtn, () => api('PATCH', `/api/clients/${c.id}`, { domain: domain.value }), 'Domain saved');
          if (r) reload();
        } }, h('h2', {}, 'Domain'), h('p', { class: 'muted small' }, 'Register the .rw domain yourself and bill it through. After saving, point DNS: an A record to 76.76.21.21 (root) or CNAME to cname.vercel-dns.com (subdomain).'),
          h('div', { class: 'row' }, domain, domBtn))),
      h('div', { class: 'stack' },
        h('form', { class: 'card stack', onsubmit: async (e) => {
          e.preventDefault();
          if (await act(payBtn, () => api('POST', `/api/clients/${c.id}/payments`, { amount: amount.value, momo_txid: txid.value, months: months.value }), (r) => `Paid until ${r.next_invoice_at}`)) reload();
        } }, h('h2', {}, 'Record MoMo payment'),
          h('div', { class: 'grid2' }, h('label', { class: 'f' }, 'Amount (RWF)', amount), h('label', { class: 'f' }, 'Transaction ID', txid), h('label', { class: 'f' }, 'Months covered', months)),
          h('div', { class: 'row' }, payBtn)),
        h('div', { class: 'card' }, h('h2', {}, 'Payments'),
          pays.rows.length ? h('ul', { class: 'list' }, pays.rows.map((x) => h('li', { class: 'row' }, h('b', {}, rwf(x.amount)), h('span', { class: 'muted small' }, when(x.paid_at)),
            h('span', { class: 'spacer' }), x.momo_txid ? h('span', { class: 'mono small' }, x.momo_txid) : null, h('span', { class: 'badge' }, `to ${x.covers_until}`)))) : h('p', { class: 'muted' }, 'No payments yet.')))));
  }

  function dataTab(panel, d, reload) {
    const p = d.prospect;
    const exp = h('button', { class: 'btn' }, 'Download everything we hold (JSON)');
    exp.onclick = async () => {
      const r = await act(exp, () => api('GET', `/api/prospects/${p.id}/export`));
      if (!r) return;
      const a = h('a', { href: URL.createObjectURL(new Blob([JSON.stringify(r, null, 2)], { type: 'application/json' })), download: `prospect-${p.id}.json` });
      document.body.append(a); a.click(); a.remove();
    };
    const erase = h('button', { class: 'btn danger' }, 'Erase this business\'s data');
    erase.onclick = async () => {
      const typed = prompt('This deletes audits, sites, outreach history and contact details, and blocks future contact. Type ERASE to confirm.');
      if (typed !== 'ERASE') return;
      if (await act(erase, () => api('POST', `/api/prospects/${p.id}/erase`, { confirm: 'ERASE' }), 'Erased')) reload();
    };
    panel.append(h('div', { class: 'card stack' }, h('h2', {}, 'Data held about this business'),
      h('p', { class: 'muted' }, 'Use these when someone asks what you hold about them, or asks you to delete it (Law Nº 058/2021).'),
      h('dl', { class: 'kv' }, h('dt', {}, 'Contact source'), h('dd', {}, p.contact_source || '–'), h('dt', {}, 'Coordinates'),
        h('dd', {}, p.lat != null ? `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)} (${p.coords_source}, ${when(p.coords_fetched_at)})` : '–'),
        h('dt', {}, 'Google place ID'), h('dd', {}, p.place_id || '–')),
      h('div', { class: 'row' }, exp, erase)));
  }

  // ---------- clients ----------
  async function clientsView(main) {
    const r = await api('GET', '/api/clients').catch((e) => { toast(e.message, true); return null; });
    if (!r) return;
    const renew = h('button', { class: 'btn' }, 'Check renewals now');
    renew.onclick = async () => { if (await act(renew, () => api('POST', '/api/renewals/check', {}), (x) => `${x.newly_overdue} overdue, ${x.suspended} suspended`)) render(); };
    const mrr = r.rows.filter((c) => c.status === 'active' || c.status === 'overdue').reduce((s, c) => s + c.monthly_fee, 0);
    main.append(h('div', { class: 'row', style: 'margin-bottom:12px' }, h('h1', {}, 'Hosting clients'), h('span', { class: 'badge info' }, `${rwf(mrr)} / month`), h('span', { class: 'spacer' }), renew));
    if (!r.rows.length) { main.append(h('div', { class: 'card empty' }, 'No clients yet. Open a prospect and use "Make client" when they say yes.')); return; }
    main.append(h('div', { class: 'tablewrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Business', 'Status', 'Paid until', 'Monthly', 'Total paid', 'Domain / URL'].map((c) => h('th', {}, c)))),
      h('tbody', {}, r.rows.map((c) => h('tr', { onclick: () => go('prospect', { prospectId: c.prospect_id, tab: 'client' }) },
        h('td', { class: 'name' }, c.business_name),
        h('td', {}, h('span', { class: 'badge ' + ({ active: 'good', overdue: 'warn', suspended: 'bad', cancelled: '' }[c.status]) }, c.status)),
        h('td', {}, c.next_invoice_at), h('td', { class: 'num' }, fmt(c.monthly_fee)), h('td', { class: 'num' }, fmt(c.total_paid)),
        h('td', { class: 'small' }, c.domain || c.live_url || '–')))))));
    main.append(h('p', { class: 'muted small' }, 'Past the paid-until date a client turns overdue. After 30 more days the site is replaced by a "renewing" page until they pay.'));
  }

  // ---------- client portal: orders, services, accounts ----------
  const ORDER_STATUS = {
    awaiting_deposit: ['Waiting for deposit', 'warn'], in_progress: ['In progress', 'info'],
    awaiting_final: ['Final payment due', 'warn'], completed: ['Completed', 'good'], cancelled: ['Cancelled', '']
  };
  const LANG_NAME = { en: 'English', rw: 'Kinyarwanda', fr: 'French' };
  const orderBadge = (s) => h('span', { class: 'badge ' + (ORDER_STATUS[s]?.[1] || '') }, ORDER_STATUS[s]?.[0] || s);
  const payBadge = (s) => h('span', { class: 'badge ' + ({ confirmed: 'good', pending: 'warn', rejected: 'bad' }[s] || '') }, { confirmed: 'Confirmed', pending: 'To check', rejected: 'Rejected' }[s] || s);
  const payKind = (k) => (k === 'deposit' ? 'Deposit' : 'Balance');

  // Shows the number of payments waiting to be checked next to "Portal" in the top bar.
  async function refreshPortalBadge() {
    const el = document.getElementById('portal-badge');
    if (!el) return;
    try {
      const r = await api('GET', '/api/orders?summary=1');
      el.textContent = r.summary.pending_payments ? String(r.summary.pending_payments) : '';
      el.hidden = !r.summary.pending_payments;
    } catch (e) { el.hidden = true; }
  }

  async function portalView(main) {
    const TABS = [['orders', 'Orders'], ['services', 'Services'], ['accounts', 'Client accounts']];
    main.append(
      h('div', { class: 'row', style: 'margin-bottom:8px' }, h('h1', {}, 'Client portal'), h('span', { class: 'spacer' }),
        h('a', { class: 'btn', href: '/portal/', target: '_blank', rel: 'noopener' }, 'Open the portal as a client sees it')),
      h('div', { class: 'tabs', role: 'tablist' }, TABS.map(([k, l]) =>
        h('button', { role: 'tab', 'aria-selected': String(state.portalTab === k), onclick: () => go('portal', { portalTab: k }) }, l))));
    const panel = h('div', { role: 'tabpanel' });
    main.append(panel);
    await ({ orders: portalOrdersTab, services: portalServicesTab, accounts: portalAccountsTab }[state.portalTab] || portalOrdersTab)(panel);
  }

  async function portalOrdersTab(panel) {
    const f = state.orderFilter;
    const r = await api('GET', '/api/orders?' + new URLSearchParams(f ? { status: f } : {})).catch((e) => { toast(e.message, true); return null; });
    if (!r) return;
    const s = r.summary;
    const stat = (key, label, n) => h('button', { class: 'stat', 'aria-pressed': String(f === key), onclick: () => { state.orderFilter = key; render(); } }, h('b', {}, fmt(n)), h('span', {}, label));
    const total = Object.values(s.counts).reduce((a, b) => a + b, 0);
    if (r.payment) {
      const m = r.payment.merchant;
      panel.append(h('div', { class: 'card pay-info' },
        m ? h('img', { src: m.qr, alt: `QR code for ${m.ussd}`, class: 'pay-qr' }) : null,
        h('div', { class: 'stack', style: 'gap:4px' },
          h('span', { class: 'small muted' }, 'Clients pay by MTN MoMo'),
          m ? h('div', {}, h('b', {}, `MoMo Pay ${m.code}`), ` (${m.name}) · dial `, h('span', { class: 'mono' }, m.ussd), ' or scan the QR code') : null,
          r.payment.number ? h('div', {}, h('b', {}, r.payment.number), ` (${r.payment.name}) · send to this number`) : null,
          h('span', { class: 'small muted' }, 'Set in .env: MOMO_MERCHANT_CODE, MOMO_MERCHANT_NAME, MOMO_PAY_NUMBER, MOMO_PAY_NAME.'))));
    }
    if (!r.momo_configured) {
      panel.append(h('p', { class: 'card', style: 'margin-bottom:12px' }, h('span', { class: 'badge warn' }, 'Set up payments'),
        ' Clients can\'t see where to pay yet. Add MOMO_PAY_NUMBER and MOMO_PAY_NAME to .env and restart the server.'));
    }
    panel.append(h('div', { class: 'stats' },
      stat('', 'All orders', total),
      Object.entries(ORDER_STATUS).map(([k, [label]]) => stat(k, label, s.counts[k]))),
      h('p', { class: 'muted small', style: 'margin:-6px 0 12px' },
        `${fmt(s.accounts)} client accounts · ${rwf(s.received)} received through the portal`,
        s.pending_payments ? [' · ', h('span', { class: 'badge warn' }, `${s.pending_payments} payment${s.pending_payments > 1 ? 's' : ''} to check`)] : null));
    if (!r.rows.length) {
      panel.append(h('div', { class: 'card empty' }, total ? 'No orders with this status.' : 'No orders yet. When a client orders a service in the portal, it appears here.'));
      return;
    }
    panel.append(h('div', { class: 'tablewrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['#', 'Client', 'Service', 'Price', 'Status', 'Progress', 'Payments', 'Updated'].map((c) => h('th', {}, c)))),
      h('tbody', {}, r.rows.map((o) => h('tr', { onclick: () => go('order', { orderId: o.id }) },
        h('td', { class: 'mono small' }, `#${o.id}`),
        h('td', { class: 'name' }, o.company, h('div', { class: 'small muted' }, o.client_name)),
        h('td', {}, o.service_name),
        h('td', { class: 'num' }, fmt(o.price)),
        h('td', {}, orderBadge(o.status)),
        h('td', {}, o.status === 'in_progress' ? `${o.progress}%` : ''),
        h('td', {}, o.pending_payments ? h('span', { class: 'badge warn' }, 'to check') : h('span', { class: 'small muted' }, `${fmt(o.paid)} paid`)),
        h('td', { class: 'muted small' }, when(o.updated_at))))))));
  }

  async function orderView(main) {
    let o;
    try { o = await api('GET', `/api/orders/${state.orderId}`); } catch (e) { main.append(h('div', { class: 'card empty' }, e.message)); return; }
    const reload = () => { render(); refreshPortalBadge(); };
    const c = o.client || {};
    main.append(
      h('button', { class: 'btn back', onclick: () => go('portal', { portalTab: 'orders' }) }, SF.icon('arrowLeft', 'sm'), 'Orders'),
      h('div', { class: 'detail-head' }, h('h1', {}, `#${o.id} · ${o.service_name}`), orderBadge(o.status), h('span', { class: 'muted' }, c.company)));

    // Client and request
    const wa = c.phone ? `https://wa.me/${c.phone.replace(/\D/g, '')}` : null;
    const clientCard = h('div', { class: 'card stack' }, h('h2', { style: 'margin:0' }, 'Client'),
      h('dl', { class: 'kv' },
        h('dt', {}, 'Name'), h('dd', {}, c.name || '–'), h('dt', {}, 'Business'), h('dd', {}, c.company || '–'),
        h('dt', {}, 'Phone'), h('dd', {}, c.phone ? [c.phone, ' · ', h('a', { href: wa, target: '_blank', rel: 'noopener noreferrer' }, 'WhatsApp')] : '–'),
        h('dt', {}, 'Email'), h('dd', {}, c.email ? h('a', { href: `mailto:${c.email}` }, c.email) : '–'),
        h('dt', {}, 'Website'), h('dd', {}, o.website || '–'),
        h('dt', {}, 'Language'), h('dd', {}, LANG_NAME[c.lang] || 'English', c.lang && c.lang !== 'en' ? h('span', { class: 'small muted' }, ' · they read the portal in this language; reply in it if you can') : null),
        h('dt', {}, 'Ordered'), h('dd', {}, when(o.created_at))),
      h('div', {}, h('div', { class: 'small muted' }, 'What they asked for'), h('div', { class: 'msg' }, o.details)));

    const paid = o.payments.filter((p) => p.status === 'confirmed').reduce((a, p) => a + p.amount, 0);
    const moneyCard = h('div', { class: 'card stack' }, h('h2', { style: 'margin:0' }, 'Money'),
      h('dl', { class: 'kv' },
        h('dt', {}, 'Price'), h('dd', {}, rwf(o.price)), h('dt', {}, 'Deposit'), h('dd', {}, rwf(o.deposit)),
        h('dt', {}, 'Balance'), h('dd', {}, rwf(o.balance)), h('dt', {}, 'Received'), h('dd', {}, h('b', {}, rwf(paid))),
        h('dt', {}, 'Due now'), h('dd', {}, o.due ? `${rwf(o.due.amount)} (${payKind(o.due.kind).toLowerCase()})` : 'nothing')),
      o.payments.length ? h('ul', { class: 'list' }, o.payments.map((p) => {
        const item = h('li', { class: 'stack', style: 'gap:6px' },
          h('div', { class: 'row' }, h('b', {}, rwf(p.amount)), h('span', { class: 'small muted' }, payKind(p.kind)), payBadge(p.status), h('span', { class: 'spacer' }), h('span', { class: 'small muted' }, when(p.submitted_at))),
          h('div', { class: 'small mono' }, `MoMo ID ${p.momo_txid}${p.payer_phone ? ` · from ${p.payer_phone}` : ''}`),
          p.reviewed_by ? h('div', { class: 'small muted' }, `${p.status} by ${p.reviewed_by} · ${when(p.reviewed_at)}${p.review_note ? ` · ${p.review_note}` : ''}`) : null);
        if (p.status === 'pending') {
          const ok = h('button', { class: 'btn primary' }, 'Confirm: money received');
          const reason = h('input', { placeholder: 'Reason, e.g. not on our MoMo statement', style: 'flex:1;min-width:200px' });
          const no = h('button', { class: 'btn danger' }, 'Reject');
          ok.onclick = async () => { if (await act(ok, () => api('POST', `/api/order-payments/${p.id}/review`, { approve: true }), 'Payment confirmed')) reload(); };
          no.onclick = async () => { if (await act(no, () => api('POST', `/api/order-payments/${p.id}/review`, { approve: false, note: reason.value }), 'Payment rejected; the client sees your reason')) reload(); };
          item.append(h('p', { class: 'small muted' }, 'Check your MoMo statement for this transaction ID and amount before confirming.'), h('div', { class: 'row' }, ok), h('div', { class: 'row' }, reason, no));
        }
        return item;
      })) : h('p', { class: 'muted small' }, 'No payments reported yet.'));

    // Delivery
    let deliveryCard = null;
    if (o.status === 'in_progress') {
      const url = h('input', { placeholder: 'https://… (the finished site, a file link…)' });
      const note = h('textarea', { rows: 4, placeholder: 'What you hand over: links, login details, instructions. The client sees this only after the final payment.' });
      const fin = h('button', { class: 'btn primary' }, 'Mark work finished and ask for the balance');
      fin.onclick = async () => { if (await act(fin, () => api('POST', `/api/orders/${o.id}/finish`, { result_url: url.value, delivery_note: note.value }), 'Client asked for the final payment')) reload(); };
      deliveryCard = h('div', { class: 'card stack' }, h('h2', { style: 'margin:0' }, 'Deliver'),
        h('label', { class: 'f' }, 'Result link', url), h('label', { class: 'f' }, 'Hand-over note', note), h('div', {}, fin));
    } else if (o.delivery_note || o.result_url) {
      deliveryCard = h('div', { class: 'card stack' }, h('h2', { style: 'margin:0' }, 'Delivery'),
        o.result_url ? h('a', { href: o.result_url, target: '_blank', rel: 'noopener noreferrer' }, o.result_url) : null,
        o.delivery_note ? h('div', { class: 'msg' }, o.delivery_note) : null,
        h('p', { class: 'small muted' }, o.status === 'completed' ? 'The client can see this.' : 'Hidden from the client until the final payment is confirmed.'));
    }

    let cancelCard = null;
    if (!['completed', 'cancelled'].includes(o.status)) {
      const why = h('input', { placeholder: 'Reason (the client sees it)', style: 'flex:1;min-width:200px' });
      const cancel = h('button', { class: 'btn danger' }, 'Cancel order');
      cancel.onclick = async () => {
        if (!confirm(paid ? `The client has paid ${rwf(paid)}. Refunds are handled outside the system. Cancel anyway?` : 'Cancel this order?')) return;
        if (await act(cancel, () => api('POST', `/api/orders/${o.id}/cancel`, { reason: why.value }), 'Order cancelled')) reload();
      };
      cancelCard = h('div', { class: 'card stack' }, h('h2', { style: 'margin:0' }, 'Cancel order'),
        h('p', { class: 'small muted' }, 'The client sees your reason on their order page. Money already paid is refunded outside SiteForge, by agreement with the client.'),
        h('div', { class: 'row' }, why, cancel));
    }

    // Timeline with a box to post progress
    const msg = h('textarea', { rows: 3, placeholder: 'Progress for the client, e.g. "Design approved, building the pages now."' });
    const prog = h('input', { type: 'number', min: 0, max: 100, step: 5, value: o.progress, style: 'width:90px', 'aria-label': 'Progress percent' });
    const post = h('button', { class: 'btn primary' }, 'Post update');
    post.onclick = async () => {
      const body = { message: msg.value };
      if (o.status === 'in_progress') body.progress = prog.value;
      if (await act(post, () => api('POST', `/api/orders/${o.id}/updates`, body), 'Update posted')) reload();
    };
    const timeline = h('div', { class: 'card stack' }, h('h2', { style: 'margin:0' }, 'Updates the client sees'),
      o.status !== 'cancelled' ? h('div', { class: 'stack', style: 'gap:8px' }, msg,
        h('div', { class: 'row' }, o.status === 'in_progress' ? [h('label', { class: 'check' }, 'Progress', prog, '%')] : null, h('span', { class: 'spacer' }), post)) : null,
      h('ul', { class: 'list' }, o.updates.slice().reverse().map((u) => h('li', {},
        h('div', { class: 'row small muted' }, h('span', { class: 'badge ' + ({ admin: 'info', client: 'good' }[u.author] || '') }, u.author === 'admin' ? `you (${u.author_name || 'admin'})` : u.author === 'client' ? 'client' : 'automatic'),
          when(u.created_at), u.progress != null ? `· ${u.progress}%` : null),
        h('div', { class: 'msg', style: 'background:none;padding:4px 0 0' }, u.message)))));

    main.append(h('div', { class: 'cols' }, h('div', { class: 'stack' }, clientCard, moneyCard, deliveryCard, cancelCard), h('div', { class: 'stack' }, timeline)));
  }

  async function portalServicesTab(panel) {
    const r = await api('GET', '/api/services').catch((e) => { toast(e.message, true); return null; });
    if (!r) return;
    panel.append(h('p', { class: 'muted', style: 'margin:0 0 12px' },
      `Clients see a service only when it has a price and "Show to clients" is on. They pay ${r.advance_percent}% to start and the rest when you mark the work finished. Price changes don't affect orders already placed.`));
    const rowFor = (s) => {
      const f = {
        name: h('input', { value: s.name, 'aria-label': 'Name' }),
        price: h('input', { type: 'number', min: 0, step: 1000, value: s.price ?? '', placeholder: 'RWF', style: 'width:130px', 'aria-label': 'Price in RWF' }),
        delivery_days: h('input', { type: 'number', min: 1, max: 365, value: s.delivery_days ?? '', style: 'width:80px', 'aria-label': 'Days to deliver' }),
        active: h('input', { type: 'checkbox', checked: Boolean(s.active) }),
        description: h('textarea', { rows: 2, 'aria-label': 'Description' }, s.description || '')
      };
      const tr = {};
      for (const l of ['rw', 'fr']) {
        tr[l] = {
          name: h('input', { value: s.i18n?.[l]?.name || '', 'aria-label': `Name in ${LANG_NAME[l]}` }),
          description: h('textarea', { rows: 2, 'aria-label': `Description in ${LANG_NAME[l]}` }, s.i18n?.[l]?.description || '')
        };
      }
      const i18nBody = () => Object.fromEntries(Object.entries(tr).map(([l, x]) => [l, { name: x.name.value, description: x.description.value }]));
      const translated = ['rw', 'fr'].filter((l) => s.i18n?.[l]?.name).map((l) => LANG_NAME[l]);
      const save = h('button', { class: 'btn primary' }, s.id ? 'Save' : 'Add service');
      save.onclick = async () => {
        const body = { name: f.name.value, price: f.price.value, delivery_days: f.delivery_days.value, active: f.active.checked, description: f.description.value, i18n: i18nBody() };
        if (await act(save, () => (s.id ? api('PATCH', `/api/services/${s.id}`, body) : api('POST', '/api/services', body)), s.id ? 'Saved' : 'Service added')) render();
      };
      return h('div', { class: 'card stack', style: 'gap:10px' },
        h('div', { class: 'row' }, h('label', { class: 'f', style: 'flex:1;min-width:220px' }, 'Name', f.name),
          h('label', { class: 'f' }, 'Price (RWF)', f.price), h('label', { class: 'f' }, 'Days', f.delivery_days),
          h('label', { class: 'check', style: 'align-self:end;min-height:34px' }, f.active, 'Show to clients')),
        h('label', { class: 'f' }, 'What the client gets', f.description),
        h('details', { class: 'translations' },
          h('summary', {}, 'Translations', h('span', { class: 'small muted' }, translated.length ? ` · ${translated.join(', ')}` : ' · none yet: clients see the English text')),
          h('div', { class: 'grid2', style: 'margin-top:10px' }, ['rw', 'fr'].map((l) => h('div', { class: 'stack', style: 'gap:8px' },
            h('b', { class: 'small' }, LANG_NAME[l]),
            h('label', { class: 'f' }, 'Name', tr[l].name),
            h('label', { class: 'f' }, 'What the client gets', tr[l].description))))),
        h('div', { class: 'row' }, s.id ? h('span', { class: 'small muted' }, `${fmt(s.orders)} order${s.orders === 1 ? '' : 's'}`) : h('span', { class: 'small muted' }, 'New service'),
          s.id && !(s.price > 0) ? h('span', { class: 'badge warn' }, 'no price yet: hidden') : s.id && s.active ? h('span', { class: 'badge good' }, 'visible to clients') : s.id ? h('span', { class: 'badge' }, 'hidden') : null,
          h('span', { class: 'spacer' }), save));
    };
    panel.append(h('div', { class: 'stack' }, r.rows.map(rowFor), h('h2', { style: 'margin:8px 0 0' }, 'Add a service'), rowFor({ name: '', description: '', price: null, delivery_days: null, active: 0 })));
  }

  async function portalAccountsTab(panel) {
    const r = await api('GET', '/api/accounts').catch((e) => { toast(e.message, true); return null; });
    if (!r) return;
    if (!r.rows.length) { panel.append(h('div', { class: 'card empty' }, 'No client accounts yet. Clients create one at /portal/.')); return; }
    const showOnce = (title, text) => {
      const dlg = h('dialog', {}, h('div', { class: 'stack' }, h('h2', {}, title), h('div', { class: 'msg mono' }, text),
        h('p', { class: 'small muted' }, 'This is shown only once. Send it to the client (for example on WhatsApp) and ask them to change it under Account.'),
        h('div', { class: 'row' }, h('span', { class: 'spacer' }), h('button', { class: 'btn primary', onclick: () => { dlg.close(); dlg.remove(); } }, 'Done'))));
      document.body.append(dlg);
      dlg.showModal();
    };
    panel.append(h('div', { class: 'tablewrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Business', 'Name', 'Phone', 'Email', 'Language', 'Orders', 'Joined', 'Last login', ''].map((c) => h('th', {}, c)))),
      h('tbody', {}, r.rows.map((u) => {
        const reset = h('button', { class: 'btn' }, 'Reset password');
        reset.onclick = async () => {
          if (!confirm(`Give ${u.name} a new temporary password? Their current password stops working.`)) return;
          const x = await act(reset, () => api('POST', `/api/accounts/${u.id}/reset-password`, {}));
          if (x) showOnce(`Temporary password for ${u.name}`, x.temporary_password);
        };
        const erase = h('button', { class: 'btn danger' }, 'Delete');
        erase.onclick = async () => {
          const typed = prompt(`Delete ${u.name}'s personal details? Orders and payments are kept without their name, phone or email. Type DELETE to confirm.`);
          if (typed !== 'DELETE') return;
          if (await act(erase, () => api('POST', `/api/accounts/${u.id}/erase`, { confirm: 'DELETE' }), 'Account deleted')) render();
        };
        return h('tr', {},
          h('td', { class: 'name' }, u.company), h('td', {}, u.name), h('td', { class: 'small' }, u.phone || '–'), h('td', { class: 'small' }, u.email || '–'),
          h('td', { class: 'small' }, LANG_NAME[u.lang] || 'English'),
          h('td', {}, `${fmt(u.orders)}${u.open_orders ? ` (${u.open_orders} open)` : ''}`),
          h('td', { class: 'small muted' }, when(u.created_at)), h('td', { class: 'small muted' }, when(u.last_login_at) || '–'),
          h('td', {}, h('div', { class: 'row' }, reset, h('a', { class: 'btn', href: `/api/accounts/${u.id}/export`, download: `account-${u.id}.json` }, 'Export'), erase)));
      })))));
    panel.append(h('p', { class: 'muted small' }, 'Law Nº 058/2021: Export gives a client everything we hold about them. Delete removes their personal details but keeps orders and payments as business records.'));
  }

  // ---------- import ----------
  function importView(main) {
    const osm = h('button', { class: 'btn primary' }, 'Import Kigali from OpenStreetMap');
    const result = h('div');
    const show = (r) => result.replaceChildren(h('div', { class: 'card' }, `Found ${fmt(r.found)}: ${fmt(r.added)} added, ${fmt(r.merged)} merged into existing, ${fmt(r.skipped)} unchanged.`));
    osm.onclick = async () => { osm.textContent = 'Querying OpenStreetMap…'; const r = await act(osm, () => api('POST', '/api/import', { source: 'osm' })); osm.textContent = 'Import Kigali from OpenStreetMap'; if (r) show(r); };
    const file = h('input', { type: 'file', accept: '.csv,text/csv' });
    const csvBtn = h('button', { class: 'btn primary' }, 'Import CSV');
    csvBtn.onclick = async () => {
      if (!file.files[0]) return toast('Choose a CSV file first.', true);
      const csv = await file.files[0].text();
      const r = await act(csvBtn, () => api('POST', '/api/import', { source: 'csv', csv }));
      if (r) show(r);
    };
    main.append(h('div', { class: 'cols' },
      h('div', { class: 'card stack' }, h('h2', {}, 'OpenStreetMap'),
        h('p', { class: 'muted' }, 'Pulls named shops, offices, hotels, clinics, schools and restaurants inside Kigali. OSM data can be stored, unlike Google\'s. Takes up to a minute.'),
        h('div', {}, osm), h('p', { class: 'attrib' }, '© OpenStreetMap contributors, ODbL')),
      h('div', { class: 'card stack' }, h('h2', {}, 'RDB register or your own list (CSV)'),
        h('p', { class: 'muted' }, 'Needs a "name" column. Also understood: TIN / registration number, activity, district, sector, phone, email, website. Duplicates are merged by ID or by name within a district.'),
        h('div', { class: 'row' }, file, csvBtn))),
    result);
  }

  // ---------- compliance ----------
  async function complianceView(main) {
    const r = await api('GET', '/api/compliance').catch((e) => { toast(e.message, true); return null; });
    if (!r) return;
    const purgeBtn = h('button', { class: 'btn' }, 'Purge Google coordinates older than 30 days');
    purgeBtn.onclick = async () => { if (await act(purgeBtn, () => api('POST', '/api/compliance/purge', {}), (x) => `Cleared ${x.cleared}`)) render(); };
    main.append(h('div', { class: 'cols' },
      h('div', { class: 'card stack' }, h('h2', {}, 'Google Maps terms'),
        h('dl', { class: 'kv' }, h('dt', {}, 'Google coordinates held'), h('dd', {}, fmt(r.google_coords)), h('dt', {}, 'Expiring within 7 days'), h('dd', {}, fmt(r.google_coords_expiring_7d))),
        h('p', { class: 'muted small' }, 'Runs automatically every day. Only place IDs are kept permanently; names, phones and hours from Google are never stored.'), h('div', {}, purgeBtn)),
      h('div', { class: 'card stack' }, h('h2', {}, 'Data protection (Law Nº 058/2021)'),
        h('dl', { class: 'kv' }, h('dt', {}, 'Prospects with contact details'), h('dd', {}, fmt(r.with_personal_contact)), h('dt', {}, 'Do-not-contact'), h('dd', {}, fmt(r.do_not_contact))),
        h('p', { class: 'muted small' }, 'Register with NCSA as a data controller before outreach at volume. Every written message carries a stop line. Export or erase one business from its Data tab.'))),
    h('div', { class: 'card', style: 'margin-top:16px' }, h('h2', {}, 'Do-not-contact list'),
      r.dnc.length ? h('ul', { class: 'list' }, r.dnc.map((x) => h('li', { class: 'row', style: 'cursor:pointer', onclick: () => go('prospect', { prospectId: x.id, tab: 'data' }) },
        h('b', {}, x.name), h('span', { class: 'muted small' }, x.district || ''), h('span', { class: 'spacer' }), h('span', { class: 'small muted' }, when(x.opt_out_at))))) : h('p', { class: 'muted' }, 'Nobody yet.')));
  }

  boot();
})();
