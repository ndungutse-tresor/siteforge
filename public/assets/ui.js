'use strict';
// Shared by the admin panel and the client portal: line icons and the SiteForge logo.
// Icons are drawn on a 24x24 grid with a 1.8 stroke (see .i in base.css).
(() => {
  const NS = 'http://www.w3.org/2000/svg';
  const P = (d) => ['path', { d }];
  const C = (cx, cy, r) => ['circle', { cx, cy, r }];
  const R = (x, y, width, height, rx) => ['rect', { x, y, width, height, rx }];

  const ICONS = {
    globe: [C(12, 12, 10), P('M2 12h20'), P('M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z')],
    refresh: [P('M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8'), P('M21 3v5h-5')],
    at: [C(12, 12, 4), P('M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8')],
    server: [R(2, 3, 20, 8, 2), R(2, 13, 20, 8, 2), P('M6 7h.01'), P('M6 17h.01')],
    wrench: [P('M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z')],
    bot: [R(3, 8, 18, 12, 3), P('M12 8V4H8'), P('M2 14h2'), P('M20 14h2'), P('M9 13v2'), P('M15 13v2')],
    check: [P('M20 6 9 17l-5-5')],
    checkCircle: [C(12, 12, 10), P('m8 12 3 3 5-6')],
    clock: [C(12, 12, 10), P('M12 6v6l4 2')],
    shield: [P('M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z'), P('m9 12 2 2 4-4')],
    phone: [P('M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z')],
    chat: [P('M7.9 20A9 9 0 1 0 4 16.1L2 22Z')],
    mail: [R(2, 4, 20, 16, 2), P('m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7')],
    wallet: [P('M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1'), P('M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4')],
    dashboard: [R(3, 3, 7, 9, 1.5), R(14, 3, 7, 5, 1.5), R(14, 12, 7, 9, 1.5), R(3, 16, 7, 5, 1.5)],
    orders: [R(8, 2, 8, 4, 1), P('M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2'), P('M12 11h4'), P('M12 16h4'), P('M8 11h.01'), P('M8 16h.01')],
    plus: [P('M12 5v14'), P('M5 12h14')],
    user: [P('M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2'), C(12, 7, 4)],
    users: [P('M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2'), C(9, 7, 4), P('M22 21v-2a4 4 0 0 0-3-3.87'), P('M16 3.13a4 4 0 0 1 0 7.75')],
    logout: [P('M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4'), P('m16 17 5-5-5-5'), P('M21 12H9')],
    lock: [R(3, 11, 18, 11, 2), P('M7 11V7a5 5 0 0 1 10 0v4')],
    eye: [P('M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0'), C(12, 12, 3)],
    alert: [P('m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3'), P('M12 9v4'), P('M12 17h.01')],
    info: [C(12, 12, 10), P('M12 16v-4'), P('M12 8h.01')],
    send: [P('M14.54 21.69a.5.5 0 0 0 .94-.03l6.5-19a.5.5 0 0 0-.64-.64l-19 6.5a.5.5 0 0 0-.03.94l7.93 3.18a2 2 0 0 1 1.11 1.11z'), P('m21.85 2.15-10.94 10.93')],
    file: [P('M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z'), P('M14 2v4a2 2 0 0 0 2 2h4'), P('M16 13H8'), P('M16 17H8'), P('M10 9H8')],
    chart: [P('M3 3v18h18'), P('m19 9-5 5-4-4-3 3')],
    target: [C(12, 12, 10), C(12, 12, 6), C(12, 12, 2)],
    store: [P('m2 7 1.6-3.2A1.5 1.5 0 0 1 4.95 3h14.1a1.5 1.5 0 0 1 1.35.8L22 7'), P('M4 7v13a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V7'), P('M2 7h20'), P('M9 21v-6h6v6')],
    briefcase: [R(2, 7, 20, 14, 2), P('M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16')],
    upload: [P('M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4'), P('m17 8-5-5-5 5'), P('M12 3v12')],
    spark: [P('M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z')],
    external: [P('M15 3h6v6'), P('M10 14 21 3'), P('M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6')],
    arrowRight: [P('M5 12h14'), P('m12 5 7 7-7 7')],
    arrowLeft: [P('M19 12H5'), P('m12 19-7-7 7-7')],
    chevronRight: [P('m9 18 6-6-6-6')],
    menu: [P('M4 6h16'), P('M4 12h16'), P('M4 18h16')],
    x: [P('M18 6 6 18'), P('m6 6 12 12')],
    pin: [P('M20 10c0 5-8 12-8 12s-8-7-8-12a8 8 0 0 1 16 0z'), C(12, 10, 3)],
    copy: [R(8, 8, 14, 14, 2), P('M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2')],
    search: [C(11, 11, 8), P('m21 21-4.3-4.3')],
    bolt: [P('M13 2 3 14h9l-1 8 10-12h-9l1-8z')],
    receipt: [P('M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z'), P('M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8'), P('M12 17.5v-11')]
  };

  function icon(name, cls = '') {
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', `i ${cls}`.trim());
    svg.setAttribute('aria-hidden', 'true');
    for (const [tag, attrs] of ICONS[name] || []) {
      const el = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
      svg.append(el);
    }
    return svg;
  }

  // The mark: a browser window in a brand-blue tile, with a sun-yellow spark (the "forge").
  function logoMark() {
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 32 32');
    svg.setAttribute('aria-hidden', 'true');
    const parts = [
      ['rect', { x: 1, y: 1, width: 30, height: 30, rx: 9, fill: 'var(--accent)' }],
      ['rect', { x: 8, y: 10, width: 16, height: 13, rx: 2.5, fill: 'none', stroke: '#fff', 'stroke-width': 2 }],
      ['path', { d: 'M8 14.5h16', stroke: '#fff', 'stroke-width': 2 }],
      ['circle', { cx: 25, cy: 7, r: 4, fill: 'var(--sun)', stroke: 'var(--surface)', 'stroke-width': 1.5 }]
    ];
    for (const [tag, attrs] of parts) {
      const el = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs)) {
        // CSS variables work in style properties, not in SVG attributes.
        if ((k === 'fill' || k === 'stroke') && String(v).startsWith('var(')) el.style.setProperty(k, v);
        else el.setAttribute(k, v);
      }
      svg.append(el);
    }
    return svg;
  }

  window.SF = { icon, logoMark, ICONS };
})();
