# Start n8n with all required environment variables
# ─────────────────────────────────────────────────────────────────────────────
# SECRETS — do NOT hard-code real values here.
# Copy .env.example to .env and fill in your values.
# The .env file is gitignored and will never be committed.
# ─────────────────────────────────────────────────────────────────────────────

# WhatsApp / Meta credentials (required)
$env:WHATSAPP_PHONE_ID = $env:WHATSAPP_PHONE_ID         # set in .env
$env:WHATSAPP_PHONE_NUMBER_ID = $env:WHATSAPP_PHONE_NUMBER_ID
$env:WHATSAPP_TOKEN = $env:WHATSAPP_TOKEN                # Meta permanent access token
$env:WHATSAPP_APP_SECRET = $env:WHATSAPP_APP_SECRET      # Meta app secret (HMAC signing)
$env:META_VERIFY_TOKEN = $env:META_VERIFY_TOKEN          # Webhook verification token

# AI / Groq
$env:GROQ_API_KEY = $env:GROQ_API_KEY                    # https://console.groq.com

# Supabase
$env:SUPABASE_URL = $env:SUPABASE_URL                    # e.g. https://xxxx.supabase.co
$env:SUPABASE_SERVICE_ROLE_KEY = $env:SUPABASE_SERVICE_ROLE_KEY

# Test/placeholder values for required env vars
$env:RESTAURANT_NAME = "My Test Restaurant"
$env:UPI_ID = "test@upi"
$env:MAX_TABLES = "10"
$env:TAX_RATE = "5"
$env:TIMEZONE = "Asia/Kolkata"
$env:OPENING_TIME = "09:00"
$env:CLOSING_TIME = "23:00"
$env:ALLERGEN_KEYWORDS = "nuts,peanut,gluten,dairy,egg,shellfish,soy,sesame"
$env:PRIVACY_POLICY_VERSION = "1.0"
$env:SUPPORT_EMAIL = "support@myrestaurant.com"
$env:SUPPORT_PHONE = "919999999999"
$env:KITCHEN_PHONE = "919999999999"
$env:TWILIO_ACCOUNT_SID = "PLACEHOLDER"
$env:TWILIO_PHONE = "+919999999999"
$env:VALID_TABLE_NUMBERS = "1,2,3,4,5,6,7,8,9,10,outside,takeaway"
$env:N8N_BLOCK_ENV_ACCESS_IN_NODE = "false"

n8n start
