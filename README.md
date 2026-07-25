# Leakline

Leakline is an assisted payment-recovery system for high-ticket offer owners and revenue operators. It turns failed and overdue instalments into prioritised recovery cases, prepares approved outreach and replies, tracks promises and follow-ups, and attributes cash recovered after intervention. The broader funnel analysis remains available as supporting evidence.

## Run locally

```bash
npm install
cp .env.example .env
npm run dev
```

Leakline now uses its own local ports so it does not collide with Closer OS:

- Production-style payment-recovery preview: `http://localhost:8797`
- Payment-recovery development web server: `http://localhost:8798`
- Payment-recovery integration/API server: `http://localhost:8797`

The Vite development app on `8798` proxies `/api` to the integration server on `8797`.

For the most reliable demo preview:

```bash
npm run demo
```

This builds Leakline, starts the production-style app in the background on `http://localhost:8797`, verifies `/api/health`, and writes the preview PID/logs to `.data/preview.pid` and `.data/preview.log`.

Useful preview commands:

```bash
npm run preview:status
npm run preview:restart
npm run preview:stop
```

For a manual production-style local build:

```bash
npm run build
PORT=8797 APP_BASE_URL=http://localhost:8797 npm start
```

Then open `http://localhost:8797`.

Closer OS intentionally remains separate at `http://localhost:5173`.

## Private pilot hosting

For the first live-client pilot, the recommended hosting path is a single Render web service. Leakline needs a long-running Node/Express backend, HTTPS, environment variables and persistent encrypted storage for integration credentials and synced records. Render fits that shape better than a static frontend host.

This repository includes `render.yaml` for a Render Blueprint:

- Runtime: Node web service
- Region: Frankfurt
- Build command: `npm ci --include=dev && npm run build && npm prune --omit=dev`
- Start command: `npm start`
- Health check: `/api/health`
- Persistent disk: `/var/data`
- Leakline data directory: `/var/data/leakline`

The hosted pilot includes invite-only authentication, admin-managed users, and separate client workspaces. Create the first account yourself; that first account becomes the admin. After that, public signup closes. New client workspaces and client/team accounts should be created from the in-app Admin page.

Required Render environment values:

```bash
APP_BASE_URL=https://your-render-service.onrender.com
LEAKLINE_ENCRYPTION_KEY=<64-character-hex-key>
LEAKLINE_INVITE_CODE=<private-code-you-send-to-the-client>
VITE_PUBLIC_CONTACT_EMAIL=<public-contact-email>
SESSION_DAYS=14
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

Create a private integration token for the target sub-account and grant access to locations, contacts, opportunities, pipelines, users and conversations. Enter the token and Location ID in Leakline. Synced contacts, deals and owners are matched to payment-recovery cases. Approved SMS and email responses are sent through the connected GoHighLevel account.

For inbound assisted replies, subscribe a HighLevel marketplace app to the **InboundMessage** webhook and set its endpoint to:

```text
https://your-render-service.onrender.com/api/webhooks/highlevel/inbound
```

Leakline verifies the current `X-GHL-Signature`, matches the `locationId` and `contactId` to the correct workspace and recovery case, ignores replayed message IDs, classifies the response and creates an editable draft. Routine recovery is paused automatically for opt-outs, disputes, refund requests, hardship and wrong contacts.

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

## Assisted recovery workflow

- **Reply needed** contains inbound customer messages with an editable, classified response draft.
- **Follow-ups due** contains customers who have not responded within the client-specific cadence.
- **Promises due** contains payment promises that passed without a verified provider payment.
- Every SMS or email requires a visible operator approval before sending.
- The one-minute recovery scheduler only marks work as due; it never sends a message autonomously.
- A successful payment sync closes the matching case, cancels outstanding follow-ups and attributes the recovered amount once.
- Workspace rules control sender identity, timezone, follow-up cadence, promise grace period, maximum touches, tone and approved templates.

## Sandbox integration testing

If you do not have live CRM, calendar, payment or call credentials yet, open **Integrations** and click **Sandbox** on a provider card. Leakline will import realistic provider-shaped sample data, label that provider as **Sandbox**, and push the normalized records through the same dashboard, leak detection and call-library paths.

Sandbox mode is useful for product testing, but it is not a substitute for final Version 2 qualification. Before calling Version 2 production-ready, each chosen live provider still needs to be connected and synced with real account data.

## Security model

- Secrets never enter browser storage.
- The public app is protected by HTTP-only session cookies and invite-only first-admin account creation.
- The first account becomes admin; admins can add, disable, restore, role-change, and reset passwords for other users from the app.
- Each client workspace has separate connected credentials, synced data, calls, imported CSV cache, and alert review state.
- Integration state is encrypted with AES-256-GCM.
- Set a stable 64-character hexadecimal `LEAKLINE_ENCRYPTION_KEY` in deployed environments.
- Set `VITE_PUBLIC_CONTACT_EMAIL` during the production build to show a direct contact email. Until it is configured, public Contact links return visitors to the audit application form.
- Landing-page applications and first-party conversion events are available only to the LeakLine owner under `/app` → Admin.
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
