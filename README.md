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
