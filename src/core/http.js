'use strict';

class HttpError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

function sendJson(res, status, body, headers) {
  const data = JSON.stringify(body);
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  }, headers));
  res.end(data);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > limit) return reject(new HttpError(413, 'too_large', 'Request is too large.'));
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        req.destroy();
        reject(new HttpError(413, 'too_large', 'Request is too large.'));
      } else {
        chunks.push(c);
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// Every state-changing request must be JSON. Browsers can't send JSON cross-site
// without a CORS preflight, which this server never grants — a CSRF guard.
async function readJson(req, limit = 100 * 1024) {
  const type = String(req.headers['content-type'] || '');
  if (!type.toLowerCase().startsWith('application/json')) {
    throw new HttpError(415, 'json_required', 'Send JSON.');
  }
  const text = await readBody(req, limit);
  if (!text) return {};
  let body;
  try { body = JSON.parse(text); } catch (e) { throw new HttpError(400, 'bad_json', 'Invalid JSON.'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'bad_json', 'Invalid JSON.');
  return body;
}

module.exports = { HttpError, sendJson, readJson };
