'use strict';
const qrcode = require('../vendor/qrcode-generator');

// QR codes as SVG, drawn from the module matrix of the (MIT-licensed) qrcode-generator library.

// USSD code for an MTN MoMo Pay merchant payment in Rwanda.
function merchantUssd(code) {
  return `*182*8*1*${code}#`;
}

// A tel: link opens the phone's dialer with the USSD code typed in. '#' must be written %23 in a URI.
function ussdTelUri(ussd) {
  return 'tel:' + ussd.replace(/#/g, '%23');
}

function qrSvg(text, { quiet = 4 } = {}) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const size = n + quiet * 2;
  let d = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + quiet} ${r + quiet}h1v1h-1z`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="QR code">`
    + `<rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#0e1726"/></svg>`;
}

module.exports = { merchantUssd, ussdTelUri, qrSvg };
