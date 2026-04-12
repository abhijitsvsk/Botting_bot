# Dev Environment Setup Guide

## Prerequisites
- Node.js 18+
- [Supabase CLI](https://supabase.com/docs/guides/cli): `npm install -g supabase`
- [ngrok](https://ngrok.com/) for tunnelling your local machine to Meta webhooks

---

## 1. Clone & Install
```bash
cd d:/Z_shared/BOT
npm install          # installs n8n compiler deps
cd kds-web
npm install          # installs React deps
```

## 2. Start Local Supabase
```bash
supabase start
# Output will give you:
#   API URL: http://localhost:54321
#   anon key: <your-local-anon-key>
```

## 3. Run Migrations
Connect to your local Postgres (default: `postgresql://postgres:postgres@localhost:54322/postgres`)
and run each migration in order:
```bash
psql postgresql://postgres:postgres@localhost:54322/postgres -f migrations/001_initial_indexes.sql
psql postgresql://postgres:postgres@localhost:54322/postgres -f migrations/002_status_rename.sql
psql postgresql://postgres:postgres@localhost:54322/postgres -f migrations/003_phase1_schema.sql
psql postgresql://postgres:postgres@localhost:54322/postgres -f migrations/004_phase2_schema.sql
```

## 4. Configure Environment
Copy `.env.example` → `.env` in both the root (for n8n compiler) and `kds-web/` (for React):
```bash
cp .env.example .env
cp kds-web/.env kds-web/.env.local  # for local override
```

Edit `kds-web/.env` for local dev:
```
VITE_SUPABASE_URL=http://localhost:54321
VITE_SUPABASE_ANON_KEY=<local-anon-key-from-supabase-start>
VITE_PROXY_SECRET=<same-value-as-PROXY_SECRET-in-api>
```

## 5. Start the KDS
```bash
cd kds-web
npm run dev         # → http://localhost:5173
```

## 6. Expose to Meta Webhooks (n8n)
In a separate terminal:
```bash
ngrok http 5678     # or whatever port your n8n runs on
# Copy the ngrok https URL and set it as your webhook URL in n8n
```

## 7. Compile the Bot
```bash
node build_bot.js
# Produces: restaurant_bot_FINAL_ALL_FEATURES.json → import into n8n
```

---

## Feature Flags
Toggle features without redeploying by updating the `settings` table:
```sql
UPDATE settings SET value = 'false' WHERE key = 'allergen_enforcement';
```
Available flags: `kitchen_status`, `bot_mode`, `allergen_enforcement`, `avg_prep_minutes`

## Rollback
Each migration file has a rollback comment at the bottom.
For the bot, re-import the previous versioned JSON (e.g., `restaurant_bot_V5_CONFIRM_FLOW.json`) into n8n.
For the KDS, Vercel keeps previous deployments — promote the prior build in your Vercel dashboard.
