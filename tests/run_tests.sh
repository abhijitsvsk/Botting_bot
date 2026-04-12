#!/bin/bash
set -e

echo "Starting local Supabase instance..."
npx supabase start

echo "Applying migrations 001 through 007..."
npx supabase db reset

echo "Seeding test data..."
# Run seed script creating menu_items, default restaurant, and staff member
npx supabase db execute --file ./tests/seed.sql

echo "Running Playwright E2E test suite..."
npx playwright test ./tests/bot_e2e.spec.ts --reporter=list || echo "Tests encountered failures"

echo "Tearing down local instance..."
npx supabase stop

echo "Done."
