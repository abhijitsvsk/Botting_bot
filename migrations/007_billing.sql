-- ==============================================================================
-- Migration 007: Billing & Subscription Infrastructure
-- ==============================================================================

CREATE TABLE IF NOT EXISTS subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID REFERENCES restaurants(id),
  plan TEXT CHECK (plan IN ('starter','growth','pro')),
  monthly_price_inr NUMERIC(10,2),
  billing_cycle_start DATE,
  billing_cycle_end DATE,
  razorpay_subscription_id TEXT,
  status TEXT CHECK (status IN ('active','past_due','cancelled')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID REFERENCES restaurants(id),
  subscription_id UUID REFERENCES subscriptions(id),
  amount_inr NUMERIC(10,2),
  period_start DATE,
  period_end DATE,
  paid_at TIMESTAMPTZ,
  razorpay_payment_id TEXT,
  status TEXT CHECK (status IN ('pending','paid','failed','waived')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS usage_metrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID REFERENCES restaurants(id),
  metric_date DATE,
  orders_count INT DEFAULT 0,
  whatsapp_messages_count INT DEFAULT 0,
  ai_calls_count INT DEFAULT 0,
  UNIQUE(restaurant_id, metric_date)
);

-- RLS Enforcement
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "SaaS Isolation Subs" ON subscriptions FOR ALL 
USING (restaurant_id = public.get_current_restaurant_id() OR restaurant_id = (SELECT restaurant_id FROM staff WHERE id = auth.uid()));

ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
CREATE POLICY "SaaS Isolation Inv" ON invoices FOR ALL 
USING (restaurant_id = public.get_current_restaurant_id() OR restaurant_id = (SELECT restaurant_id FROM staff WHERE id = auth.uid()));

ALTER TABLE usage_metrics ENABLE ROW LEVEL SECURITY;
CREATE POLICY "SaaS Isolation Usage" ON usage_metrics FOR SELECT 
USING (restaurant_id = public.get_current_restaurant_id() OR restaurant_id = (SELECT restaurant_id FROM staff WHERE id = auth.uid()));
