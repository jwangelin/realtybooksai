# RealtyBooks AI

React bookkeeping app for real estate agents and loan officers. It records income and expenses, organizes business accounts, attaches receipts or invoices, and shows cash basis summaries.

## Local setup

1. Run `npm install`.
2. Copy `.env.example` to `.env.local` and set the Supabase project URL and publishable key. Never put a service-role key or database password in a `VITE_` variable.
3. Apply `supabase/migrations/202610060001_initial.sql` in the Supabase SQL Editor.
4. In Supabase Authentication URL settings, add your local and deployed origins to the redirect allow list.
5. Run `npm run dev`.

Without Supabase settings, the app shows a read-only demo with sample entries. Live financial records require Supabase.

## Deployment

Build with `npm run build`; publish `dist` as a static site. Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` in the hosting service. Configure custom SMTP for Supabase Auth with Resend, and verify the sending domain in Resend with Cloudflare DNS. Keep secret keys out of this repository and the browser build.

The original ChatGPT Site uses browser-local storage. Its records do not automatically move to this database. Export a backup from that Site before any migration; import tooling is a separate step.

## Banking and Plaid

Each account can import a bank CSV or text-based PDF statement. Review the extracted rows before saving. Bank activity is stored separately from book entries; match a bank row to one or more book entries, including a net commission deposit matched to gross commission, broker split, and broker fees. Enter the statement beginning and ending balances to finish a monthly reconciliation when all bank rows are matched and the cleared difference is zero.

Plaid Link uses server-only Railway variables listed in `.env.example`. `PLAID_ENV=sandbox` connects only test institutions. Do not put Plaid or Supabase server secrets in any `VITE_` variable. The server validates the user's Supabase session, encrypts Plaid access tokens with the 32-byte hex `BANK_TOKEN_ENCRYPTION_KEY`, and stores them in a table inaccessible to browser users. Production bank connections require Plaid Transactions approval and a registered OAuth redirect URI.
