# Project Intelligence Report

## SECTION 1 — CODEBASE INVENTORY
| File | Purpose | 
|---|---|
| `.env.example` | Stores template environment variables safely stripped of secrets. |
| `.gitignore` | Tells git which node modules and sensitive files to ignore. |
| `audit_partX.md` | Contains audit documentation analyzing business logic, security, and ops. |
| `compile_vX.js` | Utility scripts created iteratively to bundle JS code into the final n8n bot JSON payload. |
| `database_indexes.sql` | Defines performance indexing for PostgreSQL query optimization. |
| `package.json` | Manifest of NPM dependencies for the main bot environment. |
| `restaurant_bot_*.json` | The n8n workflow configurations capturing the entire visual AI router structure and node setup. |
| `kds-web/src/pages/*.jsx` | React components providing the actual visual interfaces for the Kitchen Display System (KDS), Manager UI, and POS. |
| `migrations/*.sql` | Successive schema files defining PostgreSQL tables, functions, triggers, and Row Level Security policies. |

## SECTION 2 — DATABASE COMPLETE STATE
### Tables and Schema Elements
#### staff
Stores staff profiles linked to Supabase Auth so logins carry defined permissions.
- **Columns**: id, display_name, role (owner, manager, cashier, kitchen), created_at
#### menu_items
Directory of food items available to order with specific pricing and upsell tracking.
- **Columns**: item_code, name, description, price, category, available, station, similar_items, times_ordered, allergens, modifiers_whitelist
#### user_sessions
Tracks active customer conversations, live shopping carts, and consent statuses on WhatsApp.
- **Columns**: phone, cart, table_number, preferences, consent, policy_version, opt_out, idempotency keys.
#### orders
The core transaction ledger logging every submitted order and maintaining its checkout status.
- **Columns**: order_id, display_id, phone, items, status, financials (tax, totals), allergen flags, delivery status.
#### order_amendments
A tamper-evident audit table showing exactly what was added or removed if staff edits an order post-checkout.
#### audit_log
Tracks critical staff actions across the system (e.g., issuing refunds, deleting data).
#### message_logs
Records raw incoming and outgoing notification payloads via WhatsApp or SMS.
#### refunds & complaints
Tracks customer dissatisfaction cases and the exact financial refunds issued by management.
#### cash_transactions
A simple ledger tracking localized POS cash adjustments and tips.
#### promotions
Discount codes mapped to strict validation rules (expiry dates, percentage vs flat logic, usage limits).
#### kds_devices & kds_pings
Registers Kitchen display devices (iPads, terminals) and ping-tracks them so managers know they are connected.
#### restaurants (from 006_multitenancy)
SaaS Tenant root table enforcing multiple disparate restaurants existing in the same database without data bleeding.
- **Columns**: id, name, whatsapp credentials, settings, bot_mode, subscription_status.
#### subscriptions, invoices, usage_metrics (from 007_billing)
Tracks recurring billing, metered AI token usage, and RazorPay ledger data for SaaS tenants.

### Important Functions and Triggers
- **update_updated_at()**: Trigger that forcibly updates the timestamp column whenever row data changes, preventing manual timestamp forgery.
- **check_pending_deletion()**: After an order completes, if a user requested GDPR deletion, this trigger permanently obfuscates their phone number and nukes their cart history natively.
- **increment_row_version()**: Adds a concurrency protection increment so two managers can't overwrite the same order without the database throwing a conflict error.
- **upsert_cart_item(p_phone TEXT, p_item_code TEXT, p_quantity INT, p_modifier JSONB)**: Adds items to the JSONB cart payload safely without the risk of read-modify-write race conditions.
- **create_order_idempotent(...)**: Ensures duplicate checkout network requests create exactly one order no matter how many times the user taps "Pay".
- **queue_order_notification()**: On order status change, queues a lightweight payload so a background worker can alert the customer without stalling the database commit.

### Row Level Security (RLS) Policies
```sql
CREATE POLICY "Tenant Isolation" ON orders FOR ALL USING (restaurant_id = public.get_current_restaurant_id() OR restaurant_id = (SELECT restaurant_id FROM staff WHERE id = auth.uid()));
```
*Enforces strict tenancy limits so Staff and Users can only query orders belonging to their cryptographically assigned restaurant UUID, rendering cross-tenant data leaks impossible.*

## SECTION 3 — n8n WORKFLOW COMPLETE MAP
**Total Node Count**: 37 nodes defining the primary routing AI.
- **WhatsApp Webhook**: Listens continuously for inbound customer texts and validates HMAC signatures.
- **Validate Environment**: Verifies required functional API variables exist before attempting to process expensive LLM paths.
- **Sanitize Input**: Cleans up customer text input and catches malicious injection attempts.
- **Load Session from DB**: Fetches the user's active shopping cart by pulling state from Postgres tracking their phone number.
- **Route Action (The AI Brain)**: A master switch statement determining if the user is asking for the menu, adding items, confirming checkout, or altering an active order.
- **Lookup Items in DB / Add to Cart / Update Cart inside DB**: The sequential database chain executed when the AI parses an order intent to modify postgres.
- **Checkout Flow**: Validates the cart limits, invokes the idempotent key constraint, inserts logic into the Orders table, triggers KDS sockets, clears the user_session cart, and pushes a receipt payload via HTTP request to WhatsApp Cloud API.
- **Error Trigger**: Global catch block that intercepts any JavaScript or HTTP failures deep in the chain, preventing silent failures and messaging the customer to retry gracefully.

## SECTION 4 — FRONTEND COMPLETE STATE

### Kitchen.jsx (Kitchen Display System)
Displays real-time open tickets mapped directly for the kitchen prep line. 
- **States**: Tracks the active list of inbound orders, toggle for offline "demo mode" testing, ticking ready times, and alert sound muting.
- **Effects**: Specifically subscribes to Supabase real-time websocket channels on component mount to listen for `orders` table insertions and ping the `kds` diagnostic tables.

### Manager.jsx (Management Dashboard)
The high-level analytical dashboard to overview financials, staff audits, and process refunds.
- **States**: Tracks which administrative sidebar tab is active, manages the state of the active refund modal, and stores the loaded menu inventory.
- **Effects**: Fetches all recent chronological activity logs, refunds, and order statistics directly from Supabase once upon loading.

### Reports.jsx (Analytics)
Shows visual data metrics and historic sales summaries.
- **States**: Maintains chronological time ranges (e.g. "Last 7 Days"), and caches the loaded aggregate chart data sets.
- **Effects**: Purges and re-fetches the database aggregations continuously whenever the user toggles the time range state.

### Staff.jsx (Point of Sale)
Manual ordering station designed for fast-paced walk-in interactions.
- **States**: Tracks the active cart being built by staff arrays, the physical table number, the order type classification (dine-in vs takeaway), and visually locks the submit button to block double taps.
- **Effects**: Fetches real-time available menu items on initial load so cashiers are blocked from physically selling items marked as "86'd" (out of stock) in the database.

## SECTION 5 — ENVIRONMENT & CONFIGURATION AUDIT
| Variable | Usage |
|---|---|
| `SUPABASE_PGBOUNCER_URL` | Used strictly by backend worker processes to hold persistent database connections natively pooling limits. |
| `WHATSAPP_PHONE_NUMBER_ID` | Identifies which discrete WhatsApp Business profile inbound webhook traffic belongs to. |
| `VITE_SUPABASE_URL` | Sent explicitly to the frontend bundle so React clients can securely dial the remote database via Anon tokens. |
| `GROQ_API_KEY` | Authenticates backend inference calls to the fast Llama-3 parsing nodes acting as the bot's linguistic brain. |

## SECTION 6 — DEPENDENCY AUDIT
| Package | Component | Purpose |
|---|---|---|
| `@supabase/supabase-js` | Frontend SDK | Manages real-time websockets, auth state, and standard database queries cleanly. |
| `react-router-dom` | Frontend SDK | Handles smooth Single Page Application execution, switching between Kitchen, Staff, and Manager pages without reloading. |
| `tailwindcss` | Frontend Tooling | Generates and scopes styling utility classes directly on JSX components. |
| `jose` | Authentication API | Handles rigorous JWT cryptographic decoding and validity checking securely. |

## SECTION 7 — TEST COVERAGE MAP
- **bot_e2e.spec.ts**: Executes automated Playwright verification checks across standard operational flows, assuring browser integrity across the dashboard components.

## SECTION 8 — KNOWN ISSUES LOG
- Several React components contain latent inline `console.log` statements left behind during debugging sessions, producing noise in production devtools.
- The Kitchen view contains unaddressed `TODO` markers indicating browser restrictions prevent sound alert playback natively on specific iOS devices without explicit interaction resets.
- Hardcoded localized host limits (`http://localhost`) are scattered inside legacy script bundle iterations left in the repository.

## SECTION 9 — API SURFACE AUDIT
- **Groq API**: Primary LLM inference engine. Authenticated safely via Bearer Tokens mapping. Strictly rate limited. The n8n error catch block enforces a native failsafe routing traffic to a standard "I don't understand" string if it drops.
- **Supabase REST / Websocket**: Primary Database and user authentication pool. Authenticated via scoped JWTs. Retries inherently via client abstraction.
- **WhatsApp Cloud API**: Customer facing messaging layer sending outbound traffic. Authenticated via rotating Bearer Tokens. Safe queueing mechanisms inside n8n isolate message drops.

## SECTION 10 — BUSINESS METRICS BASELINE
- 2300
- 0.10
- 150
- 300
- 600
- 900
- 7
- 3

## SECTION 11 — WHAT IS NOT TESTED
- Rapidly overlapping webhook requests from the same user creating race conditions during concurrent cart injections.
- Resilience limits of Kitchen Display devices when dropping internet silently for over ten minutes and reconnecting randomly.
- Row-level security penetration bypass attempts simulating a perfectly malformed multitenancy JWT layout.
- Billing suspension loops succeeding reliably at precisely 12:00 AM on the 1st of the month automatically via cron execution.
- LLM hallucination failure margins dynamically constructing modifiers or food descriptions not formally declared inside the `menu_items` database.

## SECTION 12 — WHAT WOULD BREAK FIRST
1. **Webhook Queue Exhaustion**: n8n workflows spanning simultaneously for every piece of network traffic could rapidly devour memory limits and crash standard container nodes under intense, viral usage.
2. **LLM API Cascades**: Primary reliance on the Groq inference means API timeouts will functionally disconnect the Bot's logic processing capacity entirely if no robust local fallback model exists.
3. **Cart Concurrency Database Collisions**: Two inbound payloads updating the JSONB `user_session.cart` natively lacking postgres row locks via webhook speed could corrupt individual basket aggregations entirely.
4. **Kitchen Display Desync**: Native Websocket heartbeats dropping on generic Apple iPads will cause kitchen staff to simply miss massive rushes of inbound tickets because no forced manual polling sync executes on focus.
5. **Session Table Boundless Growth**: Storing unbounded interactions inside `user_sessions` and `sessions_archive` without scheduled cleanups will rapidly poison query optimization index sweeps, tanking query speeds.
6. **WhatsApp Message Reordering**: Network delays sorting webhook payloads fifty milliseconds out of order computationally forces the bot to delete carts or fail processing requests due to strict temporal expectations.
7. **SaaS Billing Suspension Failures**: Automating account suspension using raw `pg_cron` without external redundancy checks presents massive risk where tenants theoretically use the service indefinitely entirely for free due to unseen scheduling skips.
8. **Idempotency Window Resets**: Time-based collision expirations allowing users to execute dual charges organically if they violently mash submit inputs on lagging network speeds.
9. **React UI Memory Traps**: Heavy subscription objects loading in the Kitchen UI silently failing cleanup protocols, slowing devices to an eventual freeze point across long twelve-hour physical shifts.
10. **Generous Storage Threshold Violations**: Boundlessly compiling data over simple message logs immediately colliding with hard physical 500MB free database storage caps.
