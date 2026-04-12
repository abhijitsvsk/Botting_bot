# Runbook: `pg_cron` & PgBouncer Limitations

## The Issue (INFRA-8a)

Postgres relies on background workers for extensions like `pg_cron`. However, when using a Postgres connection pooler like **PgBouncer** in **Transaction Mode**, session-level variables and background-worker extensions are not compatible.
PgBouncer intercepts commands and issues them to various pooled connections, entirely stripping the required context for `pg_cron` scheduling.

If you attempt to run `SELECT cron.schedule(...)` through a standard ORM, Prisma deployment, or automated migration script pointing to `port 6543`, it will fail silently or throw transaction errors.

## The Solution

All `pg_cron` tasks must be scheduled via **direct Postgres connection (Port 5432)** or the native **Supabase SQL Editor** which bypasses the pooler.

### Runbook Steps

1. Identify required crons. For the Restaurant Bot, these are found in `migrations/pg_cron_setup.sql`.
2. Do **not** attempt to inject `pg_cron_setup.sql` into standard deployment runners or CI/CD pipelines (e.g. GitHub Actions pushing via the pooled `DATABASE_URL`).
3. Log into the **Supabase Dashboard** for the production environment.
4. Open the **SQL Editor**.
5. Copy the contents of `migrations/pg_cron_setup.sql`.
6. Run the script entirely.

### Verification

Ensure the cron jobs are actively running by querying the `cron.job` view:

```sql
SELECT * FROM cron.job;
```

This ensures KDS health-check pings and rate-limit message tables do not bloat indefinitely and crash the database.
