# SiteForge

Finds Kigali businesses whose website is missing or broken, builds each one a preview site, and hosts the site for them once they pay. It is one codebase in three parts, plus an admin panel and a client portal where businesses order services and follow the work.

Runs on Node 24 with a built-in SQLite database. The only package it installs is the Claude SDK.

## Folders

```
server.js                 admin web server + background worker
src/
  core/                   config (.env), database schema, HTTP + login helpers
  prospecting/            WHO to target
    sectors.js              sector list, willingness-to-pay factor, template per sector
    osm.js                  OpenStreetMap import (Kigali)
    rdb.js                  RDB register / any CSV import
    importer.js             merges sources into one prospect list
    places.js               Google Places: live lookups only, never stored
  scoring/                HOW BAD is their web presence (0-100)
    auditor.js              DNS, TLS, HTTP, speed, robots.txt-respecting fetch
    signals.js              parked page, viewport, copyright year, old tech, contact links
    score.js                weights x sector factor
  research/               WHAT we know to build their site
    opportunity.js          build new / needs update / check by hand
    collect.js              OpenStreetMap tags + their own website -> facts for the brief
  generation/             BUILD their site
    brief.js                the facts a site may use
    schema.js               content schema + validation (lengths, counts)
    ai.js                   Claude fills the schema (never writes HTML)
    fallback.js             placeholder copy when no API key is set
    templates/              8 sector designs, rw / en / fr
    generate.js, build.js   brief -> content -> static files
  hosting/                PUBLISH and BILL
    publish.js              approve (human gate) -> deploy
    vercel.js               Vercel deploy + custom domains
    billing.js              MoMo payments, overdue -> suspended after 30 days
  outreach/               CONTACT, with a stop line on every message
    problems.js             audit -> problems, consequences, fixes, and a support message
  portal/                 CLIENT PORTAL: accounts, services, orders (50% to start, 50% on delivery)
  compliance/             30-day Google coordinate purge, export / erase a business
  jobs/                   job queue + worker (audits 4 at a time), daily housekeeping
  api.js                  admin API
public/admin/             admin panel (pipeline, opportunities, portal orders, prospect detail, clients, import, compliance)
public/portal/            client portal (services, account, orders, MoMo payments, progress)
scripts/                  command-line tools
test/                     node --test
data/                     database, photos (not in git)
out/previews, out/sites   generated sites (not in git)
```

## Start

```powershell
cd C:\Users\ADMIN\siteforge
copy .env.example .env        # then fill in what you have
npm install
npm run create-admin -- tresor
npm start                     # http://localhost:3100/admin/
```

Every key in `.env` is optional. When a key is missing, that feature turns off or falls back:

| Key | Without it |
|---|---|
| `ANTHROPIC_API_KEY` | Sites get plain placeholder copy (orange "fallback" badge). Rewrite it before you show anyone. |
| `GOOGLE_PLACES_API_KEY` | No Google tab lookups. Websites come from OSM, RDB or your own entry. |
| `VERCEL_TOKEN` | "Publish" writes to `out/sites/<slug>/` and serves it at `/sites/<slug>/`. |
| `MOMO_PAY_NUMBER` | The portal can't tell clients where to pay; orders still work, and clients are asked to message you. |

## Daily workflow

1. **Import.** Use the Import tab, or run `npm run import -- osm` or `npm run import -- csv register.csv`.
2. **Audit.** Click "Audit unscored" or run `npm run audit`. The best prospects appear at the top.
3. **Collect.** Open Opportunities. "Build new" lists businesses with no working site (none, expired, parked, taken over, Facebook only); "Needs update" lists working sites that are outdated, insecure or not mobile-friendly. Press "Collect info for these" to gather description, services, hours, address and contacts from OpenStreetMap and their own site. "Download CSV" exports the list.
4. **Build.** Open a prospect, go to Site. The brief is pre-filled from the collected info: check it, add your own photos and press Generate. Check both languages, fix anything wrong under "Edit the copy by hand", then Approve.
5. **Visit or message.** Show the preview on your phone and log the visit on the Outreach tab. Or open the business's Problems tab: it lists each problem with what it costs them, what fixes it and the evidence, and prepares a message (English or Kinyarwanda) you can edit and open in WhatsApp or your email app. Log it once sent.
6. **Yes?** Use "Make client", record the MoMo payment, then Deploy. Add their `.rw` domain if they bought one.

## Client portal

Clients open `/portal/` (the site root redirects there), create an account with a phone number or email, and order a service.

1. **Services.** In the admin panel, Portal → Services: set a price and tick "Show to clients". A service without a price is never shown.
2. **Deposit.** The client pays 50% by MTN MoMo, either with the MoMo Pay code (`MOMO_MERCHANT_CODE`: the order page shows a QR code that opens the phone's dialer with `*182*8*1*<code>#`, and a Dial button) or by sending to `MOMO_PAY_NUMBER`, then enters the transaction ID. Portal → Orders shows "to check"; compare it with your MoMo statement and press Confirm (or Reject with a reason the client sees). Confirming starts the work.
3. **Progress.** Post updates with a percentage; the client sees them on their order page and can send you messages.
4. **Delivery.** "Mark work finished" with the result link and hand-over note. The client is asked for the other 50%; the result is shown to them only after you confirm that payment.

**Languages.** The portal is in English by default; clients can switch to Kinyarwanda or French on any page (remembered on their account, and shown to you on their orders). Portal texts live in `public/portal/i18n.js`; service names and descriptions have Kinyarwanda and French fields under Portal → Services → Translations. Updates you write yourself are shown as you wrote them.

Forgotten password: Portal → Client accounts → Reset password gives a temporary one to send them. Export and Delete handle data requests; Delete keeps orders and payments without the personal details.

## Rules built into the code

- **Google terms:** only `place_id` is stored permanently. Coordinates from Google are deleted after 30 days, automatically every day. Names, phones and hours from Google are only shown live, with attribution.
- **Law Nº 058/2021 and ICT Law 24/2016:** every written message gets a stop line. Do-not-contact can't be undone and blocks every channel. Each business has export and erase buttons.
- **Human gate:** a version can't be deployed until an admin approves it.
- **OpenStreetMap policy:** OSM tags are saved at import (one Overpass query), so collecting info never calls the OSM API once per business.
- **No dead contacts:** an email on an expired domain is never put on a generated site; mail to it would bounce.

Before you contact businesses at volume, register with NCSA as a data controller and read the law yourself.

## Tests

```powershell
npm test
npm run audit -- --url somebusiness.rw    # check any site without saving
```
