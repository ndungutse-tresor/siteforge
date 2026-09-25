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
  const when = (s) => (s ? String(s).replace('T', ' ').slice(0, 16) : '');

  function toast(msg, err) {
    const t = h('div', { class: 'toast' + (err ? ' err' : ''), role: 'status' }, msg);
    document.body.append(t);
    setTimeout(() => t.remove(), err ? 6000 : 3000);
  }

  async function api(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: 'same-origin'
    });
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
    prospectId: null,
    tab: 'overview',
    lang: 'rw',
    frameMobile: false,
    previewSite: null
  };

  // ---------- shell ----------
  async function boot() {
    try { state.me = await api('GET', '/api/me'); } catch (e) { state.me = null; }
    const m = location.hash.match(/^#p(\d+)(?:\/(\w+))?$/);
    if (m) { state.view = 'prospect'; state.prospectId = Number(m[1]); state.tab = m[2] || 'overview'; }
    else if (/^#(opportunities|clients|import|compliance)$/.test(location.hash)) state.view = location.hash.slice(1);
    render();
  }

  function go(view, extra = {}) {
    Object.assign(state, { view }, extra);
    const hash = view === 'prospect' ? `#p${state.prospectId}/${state.tab}` : view === 'pipeline' ? '' : `#${view}`;
    history.replaceState(null, '', location.pathname + hash);
    render();
    window.scrollTo(0, 0);
  }

  function render() {
    $app.replaceChildren();
    if (!state.me) return $app.append(loginView());
    const f = state.me.features;
    const navItem = (key, label) => h('button', { 'aria-current': state.view === key || (key === 'pipeline' && state.view === 'prospect') ? 'page' : null, onclick: () => go(key) }, label);
    $app.append(
      h('header', { class: 'top' }, h('div', { class: 'inner' },
        h('span', { class: 'logo' }, 'SiteForge'),
        h('nav', { class: 'nav' }, navItem('pipeline', 'Pipeline'), navItem('opportunities', 'Opportunities'), navItem('clients', 'Clients'), navItem('import', 'Import'), navItem('compliance', 'Compliance')),
        h('span', { class: 'spacer' }),
        h('span', { class: 'feat' },
          h('span', { class: 'badge ' + (f.places ? 'good' : ''), title: 'Google Places API' }, 'Places ' + (f.places ? 'on' : 'off')),
          h('span', { class: 'badge ' + (f.ai ? 'good' : 'warn'), title: f.ai ? f.ai_model : 'No ANTHROPIC_API_KEY: placeholder copy' }, 'Claude ' + (f.ai ? 'on' : 'off')),
          h('span', { class: 'badge ' + (f.vercel ? 'good' : ''), title: 'Vercel deploys' }, 'Vercel ' + (f.vercel ? 'on' : 'local'))),
        h('span', { class: 'muted' }, state.me.username),
        h('button', { class: 'btn', onclick: async () => { await api('POST', '/api/logout', {}); state.me = null; render(); } }, 'Log out'))),
      h('main', { id: 'main' })
    );
    const main = document.getElementById('main');
    ({ pipeline: pipelineView, opportunities: opportunitiesView, prospect: prospectView, clients: clientsView, import: importView, compliance: complianceView })[state.view](main);
  }

  function loginView() {
    const user = h('input', { autocomplete: 'username', required: true });
    const pass = h('input', { type: 'password', autocomplete: 'current-password', required: true });
    const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Log in');
    return h('div', { class: 'login' }, h('form', { class: 'card', onsubmit: async (e) => {
      e.preventDefault();
      const ok = await act(btn, () => api('POST', '/api/login', { username: user.value, password: pass.value }));
      if (ok) boot();
    } }, h('h1', {}, 'SiteForge admin'), h('label', { class: 'f' }, 'Username', user), h('label', { class: 'f' }, 'Password', pass), btn));
  }

  // ---------- pipeline ----------
  function scoreBadge(s) {
    if (s == null) return h('span', { class: 'score lo', title: 'Not audited' }, '–');
    return h('span', { class: 'score ' + (s >= 50 ? 'hi' : s >= 25 ? 'mid' : 'lo') }, s);
  }
  const STATUS_CLASS = { live: 'good', none: 'bad', 'dns-dead': 'bad', 'taken-over': 'bad', parked: 'bad', unreachable: 'bad', timeout: 'bad', 'ssl-error': 'bad',
    'invalid-url': 'bad', 'social-only': 'warn', blocked: '', 'robots-blocked': '' };
  const statusBadge = (s) => (s ? h('span', { class: 'badge ' + (STATUS_CLASS[s] ?? (s.startsWith('http-') ? 'bad' : '')) }, s) : h('span', { class: 'muted' }, '–'));
  const stageBadge = (s) => h('span', { class: 'badge ' + ({ won: 'good', interested: 'info', lost: 'bad', dormant: '' }[s] ?? 'info') }, s);

  async function pipelineView(main) {
    const f = state.filters;
    const [stats, list] = await Promise.all([
      api('GET', '/api/stats'),
      api('GET', '/api/prospects?' + new URLSearchParams(Object.entries(f).filter(([, v]) => v)))
    ]).catch((e) => { toast(e.message, true); return [null, null]; });
    if (!stats) return;

    const stat = (key, label, n) => h('button', { class: 'stat', 'aria-pressed': String(f.stage === key), onclick: () => { f.stage = key; render(); } }, h('b', {}, fmt(n)), h('span', {}, label));
    main.append(h('div', { class: 'stats' },
      stat('', 'All prospects', stats.total),
      state.me.stages.map((s) => stat(s, s, stats.byStage[s]))));

    let t;
    const search = h('input', { type: 'search', placeholder: 'Search name or notes', value: f.q, oninput: () => { clearTimeout(t); t = setTimeout(() => { f.q = search.value; render(); }, 350); } });
    const sel = (key, opts, label) => h('select', { 'aria-label': label, onchange: (e) => { f[key] = e.target.value; render(); } },
      opts.map(([v, l]) => h('option', { value: v, selected: f[key] === v }, l)));
    const queueBtn = h('button', { class: 'btn', title: 'Queue audits for every prospect without a score' }, `Audit unscored (${fmt(stats.unaudited)})`);
    queueBtn.onclick = () => act(queueBtn, () => api('POST', '/api/audit-queue', { limit: 500 }), (r) => `${r.queued} audits queued. They run 4 at a time in the background.`);

    main.append(h('div', { class: 'row', style: 'margin-bottom:12px' },
      search,
      sel('sector', [['', 'All sectors'], ...Object.entries(state.me.sectors)], 'Sector'),
      sel('district', [['', 'All districts'], ...list.districts.map((d) => [d, d])], 'District'),
      sel('sort', [['score', 'Best prospects first'], ['updated', 'Recently updated'], ['created', 'Newest'], ['name', 'Name']], 'Sort'),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: f.hide_dnc === '1', onchange: (e) => { f.hide_dnc = e.target.checked ? '1' : ''; render(); } }), 'Hide do-not-contact'),
      h('span', { class: 'spacer' }),
      queueBtn,
      h('button', { class: 'btn primary', onclick: addProspectDialog }, 'Add prospect')));

    if (!list.rows.length) {
      main.append(h('div', { class: 'card empty' }, stats.total ? 'No prospects match these filters.' : 'No prospects yet. Use Import to pull businesses from OpenStreetMap or an RDB export, or add one by hand.'));
      return;
    }
    main.append(h('div', { class: 'tablewrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Score', 'Business', 'Sector', 'District', 'Website', 'Stage', 'Updated'].map((c) => h('th', {}, c)))),
      h('tbody', {}, list.rows.map((p) => h('tr', { onclick: () => go('prospect', { prospectId: p.id, tab: 'overview' }) },
        h('td', {}, scoreBadge(p.score)),
        h('td', { class: 'name' }, p.name, p.do_not_contact ? [' ', h('span', { class: 'badge bad' }, 'do not contact')] : null),
        h('td', {}, state.me.sectors[p.sector] || p.sector),
        h('td', {}, p.district || ''),
        h('td', {}, statusBadge(p.website_status)),
        h('td', {}, stageBadge(p.stage)),
        h('td', { class: 'muted small' }, when(p.updated_at))))))));
    main.append(h('p', { class: 'muted small' }, `Showing ${list.rows.length} of ${fmt(list.total)}.`));
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
      h('tbody', {}, r.rows.map((p) => h('tr', { onclick: () => go('prospect', { prospectId: p.id, tab: 'overview' }) },
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

    const stageSel = h('select', { 'aria-label': 'Stage', onchange: (e) => act(null, () => api('PATCH', `/api/prospects/${p.id}`, { stage: e.target.value }), 'Stage updated') },
      state.me.stages.map((s) => h('option', { value: s, selected: p.stage === s }, s)));
    main.append(
      h('button', { class: 'btn back', onclick: () => go('pipeline') }, '← Pipeline'),
      h('div', { class: 'detail-head' }, scoreBadge(p.score), h('h1', {}, p.name), statusBadge(p.website_status), stageSel,
        p.do_not_contact ? h('span', { class: 'badge bad' }, 'Do not contact') : null));

    const TABS = [['overview', 'Overview'], ['google', 'Google'], ['site', 'Site'], ['outreach', 'Outreach'], ['client', d.client ? 'Client' : 'Make client'], ['data', 'Data']];
    main.append(h('div', { class: 'tabs', role: 'tablist' }, TABS.map(([k, l]) =>
      h('button', { role: 'tab', 'aria-selected': String(state.tab === k), onclick: () => go('prospect', { tab: k }) }, l))));
    const panel = h('div', { role: 'tabpanel' });
    main.append(panel);
    ({ overview: overviewTab, google: googleTab, site: siteTab, outreach: outreachTab, client: clientTab, data: dataTab })[state.tab](panel, d, reload);
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
        h('p', {}, `Raw ${b.raw}/100 × sector factor ${b.wtp} = `, h('b', {}, String(b.score))),
        b.breakdown.length ? h('div', { class: 'stack', style: 'gap:8px' }, b.breakdown.map((x) => h('div', { class: 'bar' },
          h('span', {}, x.label), h('b', {}, `+${x.points}`), h('div', { class: 'track' }, h('div', { class: 'fill', style: `width:${Math.min(100, x.points * 2.5)}%` }))))) : h('p', { class: 'muted' }, 'No problems found: the site looks healthy.')
      ] : h('p', { class: 'muted' }, 'Not audited yet.'));

    const audits = h('div', { class: 'card' }, h('h2', {}, 'Audit history'),
      d.audits.length ? h('ul', { class: 'list' }, d.audits.map((a) => h('li', {},
        h('div', { class: 'row' }, h('b', {}, `Score ${a.score}`), h('span', { class: 'muted small' }, when(a.checked_at)), h('span', { class: 'spacer' }),
          a.http_status ? h('span', { class: 'badge' }, `HTTP ${a.http_status}`) : null, a.load_ms != null ? h('span', { class: 'badge' }, `${a.load_ms} ms`) : null,
          a.cms_detected ? h('span', { class: 'badge' }, a.cms_detected) : null),
        a.final_url ? h('div', { class: 'small mono' }, a.final_url) : null,
        a.signals?.website_source ? h('div', { class: 'small muted' }, `Website from: ${a.signals.website_source}`) : null,
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
      } }, h('h2', {}, 'They said yes'),
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
    main.append(h('div', { class: 'row', style: 'margin-bottom:12px' }, h('h1', {}, 'Clients'), h('span', { class: 'badge info' }, `${rwf(mrr)} / month`), h('span', { class: 'spacer' }), renew));
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
