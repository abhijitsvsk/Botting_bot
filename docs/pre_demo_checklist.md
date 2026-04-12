# Pre-Demo Checklist

This document ensures the multi-tenant SaaS environment is functionally validated before demonstrating the WhatsApp Bot.

- [ ] Verify restaurants table has 1 row with correct phone_number_id.
- [ ] Verify subscription_status = 'trial' and trial_ends_at is future.
- [ ] Verify RLS isolation test passes ensuring data segregation.
