# Corrected Cost Model Analysis

## Token Economics per Order
- **Input Tokens:** 1835
- **Output Tokens:** 150
- **Total Tokens:** 1985

## Pricing Assumptions
- GPT-4o-mini Input (60% Cache Hit): $0.09 per 1M tokens
- GPT-4o-mini Output: $0.60 per 1M tokens
- Groq 8B: $0.05 per 1M input / $0.08 per 1M output
- **Groq Free Tier Note:** Groq costs ₹0 mechanically under 14,400 messages/day.

## Monthly Cost Projections

| Orders/day | Monthly orders | Input tokens/mo | Output tokens/mo | GPT cost USD | GPT cost INR | Groq cost INR | Total INR/month | Cost per order INR |
|---|---|---|---|---|---|---|---|---|
| 50 | 1,500 | 2,752,500 | 225,000 | $0.38 | ₹35.59 | ₹0.00 | ₹35.59 | ₹0.024 |
| 100 | 3,000 | 5,505,000 | 450,000 | $0.77 | ₹71.19 | ₹0.00 | ₹71.19 | ₹0.024 |
| 150 | 4,500 | 8,257,500 | 675,000 | $1.15 | ₹106.78 | ₹0.00 | ₹106.78 | ₹0.024 |
| 200 | 6,000 | 11,010,000 | 900,000 | $1.53 | ₹142.37 | ₹0.00 | ₹142.37 | ₹0.024 |
| 300 | 9,000 | 16,515,000 | 1,350,000 | $2.30 | ₹213.56 | ₹0.00 | ₹213.56 | ₹0.024 |
| 500 | 15,000 | 27,525,000 | 2,250,000 | $3.83 | ₹355.93 | ₹0.00 | ₹355.93 | ₹0.024 |

## Scaling Thresholds

Calculated using the strict baseline of ₹0.0237 per complete logical order interaction:

- **AI costs exceed ₹500/month at:** ~21,071 orders/month (**~702 orders/day**)
- **AI costs exceed ₹1000/month at:** ~42,142 orders/month (**~1,404 orders/day**)
- **AI costs exceed ₹2000/month at:** ~84,285 orders/month (**~2,809 orders/day**)
