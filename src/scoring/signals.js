'use strict';

// Pure HTML checks. Everything here works on a page string so it is easy to test.

const PARKING = [
  /sedo(parking)?\.com/i, /parkingcrew/i, /bodis\.com/i, /dan\.com/i, /afternic/i, /hugedomains/i,
  /parklogic/i, /above\.com/i, /this domain (is|may be) for sale/i, /buy this domain/i,
  /domain (is )?parked/i, /the domain .{0,40} (has expired|is available)/i,
  /future home of something quite cool/i, /website coming soon/i, /index of \//i,
  /default web site page/i, /welcome to nginx/i, /apache2? .{0,20}default page/i, /it works!/i,
  /cpanel.{0,40}(default|suspended)/i, /account (has been )?suspended/i,
  /defaultwebpage\.cgi/i, /location\.href\s*=\s*["']\/lander["']/i
];

function isParked(html) {
  const head = html.slice(0, 60000);
  return PARKING.some((re) => re.test(head));
}

function hasViewport(html) {
  return /<meta[^>]+name=["']?viewport["']?[^>]*content=["'][^"']*width=device-width/i.test(html);
}

// Fixed pixel widths of 900+ on the page container are the classic desktop-only layout.
function hasFixedWideLayout(html) {
  return /(?:width\s*[:=]\s*["']?)(9\d\d|1\d{3})(px)?["';\s>]/i.test(html.slice(0, 80000)) &&
    !/@media[^{]*max-width/i.test(html);
}

function isMobileFriendly(html) {
  return hasViewport(html) && !hasFixedWideLayout(html);
}

function lastCopyrightYear(html) {
  const text = html.replace(/&copy;|&#169;|&#xa9;/gi, '©');
  const years = [];
  for (const m of text.matchAll(/(?:©|copyright|\(c\))\s*(?:[^<\d]{0,20})?((?:19|20)\d\d)(?:\s*[-–]\s*((?:19|20)\d\d))?/gi)) {
    years.push(Number(m[2] || m[1]));
  }
  return years.length ? Math.max(...years) : null;
}

function obsoleteTech(html) {
  const found = [];
  if (/<(object|embed)[^>]+(\.swf|shockwave-flash)/i.test(html)) found.push('flash');
  const jq = html.match(/jquery[.-]?(\d)\.(\d+)(?:\.\d+)?(?:\.min)?\.js/i);
  if (jq && Number(jq[1]) === 1) found.push(`jquery ${jq[1]}.${jq[2]}`);
  if ((html.match(/<table/gi) || []).length >= 4 && !/<(div|section|main)[^>]+class=/i.test(html)) found.push('table layout');
  if (/<(frameset|marquee|blink|font)\b/i.test(html)) found.push('deprecated tags');
  return found;
}

function hasContactInfo(html) {
  return /href=["'](tel:|mailto:|https?:\/\/(wa\.me|api\.whatsapp\.com|chat\.whatsapp\.com))/i.test(html) ||
    /(\+?250[\s-]?)?07[2389]\d[\s-]?\d{3}[\s-]?\d{3}/.test(html.replace(/<[^>]+>/g, ' '));
}

function detectCms(html) {
  if (/wp-content|wp-includes/i.test(html)) return 'wordpress';
  if (/content=["']Joomla/i.test(html)) return 'joomla';
  if (/wix\.com|wixstatic/i.test(html)) return 'wix';
  if (/squarespace/i.test(html)) return 'squarespace';
  if (/shopify/i.test(html)) return 'shopify';
  if (/Drupal/i.test(html)) return 'drupal';
  if (/__next|_next\/static/i.test(html)) return 'nextjs';
  return null;
}

// Words that say what a business is, not which one it is.
const GENERIC_NAME_WORDS = new Set(('the and des du de la le les ltd limited sarl company group rwanda kigali hotel hotels restaurant '
  + 'cafe bar shop store clinic clinique pharmacy pharmacie school ecole high centre center house guest lodge motel service services '
  + 'international supermarket boutique salon garage church eglise office agency').split(' '));

const fold = (s) => String(s || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

// The distinctive words in a business name: "Hôtel Chez Lando" -> ["chez", "lando"].
function nameTokens(name) {
  return fold(name).split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !GENERIC_NAME_WORDS.has(w));
}

// True when the page text contains at least one distinctive word of the business name.
function mentionsName(html, name) {
  const tokens = nameTokens(name);
  if (!tokens.length) return true; // nothing distinctive to look for
  const t = fold(String(html).replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' '));
  return tokens.some((w) => t.includes(w));
}

const SPAM = /casino|slot\s?(gacor|online)|togel|judi|gambl|sportsbook|betting|poker online|viagra|cialis|娱乐|彩票|博彩|太阳集团|赌/i;

// An expired domain bought by someone else: the page never names the business and is spam
// or mostly Chinese/Japanese/Korean text (a Kigali business site would not be).
function looksTakenOver(html, name) {
  if (mentionsName(html, name)) return false;
  const t = String(html).replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ');
  const letters = t.match(/\p{L}/gu) || [];
  const cjk = t.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu) || [];
  return SPAM.test(t) || (letters.length > 50 && cjk.length / letters.length > 0.3);
}

// A social profile or link page used instead of a website.
function isSocialUrl(url) {
  try {
    return /(^|\.)(facebook\.com|fb\.com|fb\.me|instagram\.com|linktr\.ee|tiktok\.com|x\.com|twitter\.com|wa\.me)$/i
      .test(new URL(url).hostname);
  } catch (e) {
    return false;
  }
}

// Pages that only forward the visitor: <meta http-equiv="refresh"> or a one-line
// window.location script. Returns the target (possibly relative) or null.
function pageRedirect(html) {
  const head = html.slice(0, 20000);
  const text = head.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<[^>]+>/gi, '').trim();
  if (text.length > 200) return null;
  const meta = head.match(/<meta[^>]+http-equiv=["']?refresh["']?[^>]*content=["']?\s*\d*\s*;?\s*url\s*=\s*['"]?([^"'>\s]+)/i);
  if (meta) return meta[1];
  const js = head.match(/(?:window\.|document\.)?location(?:\.href)?\s*=\s*["']([^"']+)["']/i);
  return js ? js[1] : null;
}

module.exports = { isParked, hasViewport, isMobileFriendly, lastCopyrightYear, obsoleteTech, hasContactInfo, detectCms, isSocialUrl, pageRedirect,
  nameTokens, mentionsName, looksTakenOver };
