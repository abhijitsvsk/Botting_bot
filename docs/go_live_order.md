# Go Live Order

Execute migrations and tests in the following order when deploying to production:

- [ ] Execute `npx supabase db reset` to process schema files in sequence (from `001_initial.sql` up to `007_billing.sql`).
- [ ] Ensure the KDS frontend components are compiled and deployed to Vercel.
- [ ] Run `node compile_v9_blockers.js` to build the n8n logic blocks, then import `restaurant_bot_V9_BLOCKERS.json` to the n8n instance.

## Multi-Tenant Specific Deployments
- [ ] Run `006_multitenancy.sql` logic strictly, evaluating all single-tenant RLS shifts.
- [ ] Run `007_billing.sql` to initialize subscription tables.
- [ ] Update `pg_cron_setup.sql` with new daily metrics job inside the Supabase direct SQL Editor (PORT 5432).
- [ ] Set `SUPABASE_JWT_SECRET` for multi-tenant claim validation.
