# Monobank Jar sponsor tracking — setup and test

This feature watches an external Monobank Jar and marks a Telegram account as a **sponsor** after a confirmed incoming transaction. It does not activate Premium, change tariffs, or increase limits.

## Required Render environment variables

- `MONOBANK_TOKEN` — private Monobank personal API token. Keep it only in Render Environment; never put it in Mini App code, GitHub, or chat.
- `MONOBANK_JAR_ID` — the Jar/account identifier accepted by the Monobank statement API, not necessarily the short slug in the public share URL.
- `MONOBANK_JAR_URL` — public share URL, expected to begin with `https://send.monobank.ua/`; this is only used for the Mini App button.

If either token or Jar ID is absent, polling stays disabled. No Monobank request is made.

## Database migration

Apply `docs/sql/20261027_external_donation_sponsor_tracking.sql` to the Supabase project before enabling the watcher. It adds `users.is_sponsor`, `users.sponsor_since`, a durable sync cursor, and an idempotent transaction ledger. The migration is additive and does not alter Premium/payment data.

The backend must have `SUPABASE_SERVICE_ROLE_KEY` configured in Render. Do not expose this key to the browser.

## How a donation is matched

1. The watcher requests the Jar statement no more frequently than once per 60 seconds.
2. Only positive incoming transactions whose entire `comment` is a numeric Telegram ID are matched. For example, if the account ID is `123456789`, the comment must be exactly `123456789` (spaces around it are tolerated). Text such as `donation 123456789` is deliberately ignored.
3. The transaction ID is unique in the ledger, so retries are idempotent.
4. The cursor advances only after the returned statement window has been processed successfully.
5. The Mini App checks `GET /api/user/sponsor-status` using signed Telegram `initData`, every 60 seconds. The status endpoint does not accept a Telegram ID supplied by the client.
6. Sponsor status is a badge only. It never unlocks Premium or modifies search/filter limits.

## Test plan

1. Apply the database migration.
2. Set the three environment variables in the **test Render service first**, not production.
3. Deploy the feature branch to a test service configured with the same required Supabase schema and a test Jar/token, if available.
4. Run `npm test` and verify `GET /health`.
5. Open the Mini App through Telegram. Confirm the donation button points to the configured public Jar URL and the sponsor status endpoint responds for the signed-in user.
6. Make a small test transfer only if you control the test Jar. Put the test Telegram account's numeric ID in the transfer comment, with no other text.
7. Confirm one ledger row, `users.is_sponsor = true`, a non-null `sponsor_since`, and the badge refreshes within roughly 1–2 minutes.
8. Repeat a statement poll and verify no duplicate ledger row appears. Confirm a negative/outgoing transaction and a non-numeric comment are ignored.

## Operational notes

- Monobank token and Jar ID are secrets/configuration; never log their values.
- Run one active watcher instance per Jar. The in-process guard prevents overlapping polls in one process; it is not a distributed lock across multiple replicas.
- Do not use a real public Jar for automated end-to-end testing unless you are comfortable with the test transfer being real.
- The watcher is intentionally separate from Telegram Stars subscriptions.
