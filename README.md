# Leakline

Leakline is a revenue-leak dashboard for high-ticket sales teams. Version 1 supports normalized CSV imports; Version 2 adds live GoHighLevel, Google Calendar, Stripe and Fathom connections behind an encrypted local backend.

## Run locally

```bash
npm install
cp .env.example .env
npm run dev
```

Leakline now uses its own local ports so it does not collide with Closer OS:

- Production-style Leakline preview: `http://localhost:8787`
- Leakline development web server: `http://localhost:8788`
- Leakline integration/API server: `http://localhost:8787`

The Vite development app on `8788` proxies `/api` to the integration server on `8787`.

For the most reliable demo preview:

```bash
npm run demo
```

This builds Leakline, starts the production-style app in the background on `http://localhost:8787`, verifies `/api/health`, and writes the preview PID/logs to `.data/preview.pid` and `.data/preview.log`.

Useful preview commands:

```bash
npm run preview:status
npm run preview:restart
npm run preview:stop
```

For a manual production-style local build:

```bash
npm run build
PORT=8787 APP_BASE_URL=http://localhost:8787 npm start
```

Then open `http://localhost:8787`.

Closer OS intentionally remains separate at `http://localhost:5173`.

## Private pilot hosting

For the first live-client pilot, the recommended hosting path is a single Render web service. Leakline needs a long-running Node/Express backend, HTTPS, environment variables and persistent encrypted storage for integration credentials and synced records. Render fits that shape better than a static frontend host.

This repository includes `render.yaml` for a Render Blueprint:

- Runtime: Node web service
- Region: Frankfurt
- Build command: `npm ci && npm run build`
- Start command: `npm start`
- Health check: `/api/health`
- Persistent disk: `/var/data`
- Leakline data directory: `/var/data/leakline`

The hosted pilot includes invite-only authentication. The first client creates their own login with the invite code you set in Render. By default, signup closes after the first account is created so the public URL does not become open registration.

Required Render environment values:

```bash
APP_BASE_URL=https://your-render-service.onrender.com
LEAKLINE_ENCRYPTION_KEY=<64-character-hex-key>
LEAKLINE_INVITE_CODE=<private-code-you-send-to-the-client>
SESSION_DAYS=30
```

Generate a local encryption key with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

If Google Calendar is used in production, also set:

```bash
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=https://your-render-service.onrender.com/api/integrations/google-calendar/callback
```

Do not commit `.env`, `.data`, client credentials or production integration tokens.

## Version 2 connections

Open **Integrations** inside Leakline.

### GoHighLevel

Create a private integration token for the target sub-account and grant read-only access to locations, contacts, opportunities, pipelines and users. Enter the token and Location ID in Leakline. Synced contacts, deals and owners replace the corresponding CSV datasets.

Official setup: https://marketplace.gohighlevel.com/docs/

### Google Calendar

1. Create a Google Cloud OAuth web client and enable Google Calendar API.
2. Add this authorized redirect URI: `http://localhost:8787/api/integrations/google-calendar/callback`.
3. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `GOOGLE_REDIRECT_URI` in `.env`.
4. Restart Leakline and connect Google Calendar from Integrations.

Leakline requests only `calendar.readonly` and imports timed events from the previous 90 days.

Official setup: https://developers.google.com/identity/protocols/oauth2/web-server

### Stripe

Use a restricted key with **Charges: Read** and **Invoices: Read**, or a test-mode secret key. Leakline imports successful charges, failed charges, refunds and unpaid/overdue invoices. Stripe amounts are converted from minor units.

Official API: https://docs.stripe.com/api

### Fathom

Generate an API key under Fathom **User Settings → API Access**. Leakline imports meetings, participants, summaries and transcripts. View them under **Calls**.

Official quickstart: https://developers.fathom.ai/quickstart

## Sync behavior

- **Sync now** updates one provider.
- **Sync all** updates every connected provider.
- The backend automatically syncs connected providers every 15 minutes by default; configure `AUTO_SYNC_MINUTES` to change it.
- Live datasets are merged with CSV datasets. A live provider owns only its corresponding dataset.
- Disconnecting a provider removes its live records while preserving unrelated CSV imports.

## Sandbox integration testing

If you do not have live CRM, calendar, payment or call credentials yet, open **Integrations** and click **Sandbox** on a provider card. Leakline will import realistic provider-shaped sample data, label that provider as **Sandbox**, and push the normalized records through the same dashboard, leak detection and call-library paths.

Sandbox mode is useful for product testing, but it is not a substitute for final Version 2 qualification. Before calling Version 2 production-ready, each chosen live provider still needs to be connected and synced with real account data.

## Security model

- Secrets never enter browser storage.
- The public app is protected by HTTP-only session cookies and invite-only account creation.
- The first pilot account is the only self-signup account unless `ALLOW_ADDITIONAL_USERS=true` is set.
- Integration state is encrypted with AES-256-GCM.
- Set a stable 64-character hexadecimal `LEAKLINE_ENCRYPTION_KEY` in deployed environments.
- Without a configured key, Leakline generates a local key in `.data/local.key` with owner-only permissions.
- Google OAuth uses a short-lived state value and read-only scope.
- `.env`, `.data`, build outputs and dependencies are ignored by Git.

## Verification

```bash
npm run lint
npm test
npm run build
```

The automated suite covers CSV normalization, leak totals, reporting windows, encrypted storage, provider normalization and a full Stripe connect-and-sync request through the HTTP API.
