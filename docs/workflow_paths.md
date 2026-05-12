# N8N Workflow Path Traces

PATH A — Brand new customer, first ever message
Trigger: New incoming WhatsApp text
Node 1: WhatsApp Webhook — Listens to incoming WhatsApp data — Emits payload
Node 2: Validate Environment — Checks ENV variables — Passes
Node 3: Extract Message Data — Formats payload — Passes
Node 4: Sanitize Input — Filters prompt injection — Emits Safe
Node 5: Check Sanitization Error — Validates boolean — True Branch
Node 7: Load Session from DB — Pulls User Session via SQL — Row returned
Node 8: Process Session — Modifies state locally — Validates
Node 9: Save Session to DB — Re-dumps JSON to Postgres — Updates DB
Node 10: Check Table Set — Validates if table is in session — False Branch
Node 11: Ask Table Number — Sends WhatsApp message to user — Hit Meta API
Terminal: Table is unset in DB, session created if missing, user receives "What is your table number?"
Failure points: Node 4 (fails validation, routes to Node 5 False), Node 7 (DB timeout -> Node 36).

PATH B — Existing customer adds item to cart  
Trigger: Customer replies "I want a pizza"
Node 1: WhatsApp Webhook — Captures payload — Emits
Node 2: Validate Environment — Checks ENV variables — Passes
Node 3: Extract Message Data — Maps message logic — Passes
Node 4: Sanitize Input — Approves text — Passes
Node 5: Check Sanitization Error — Confirms safe — Passes
Node 7: Load Session from DB — Grabs active session — Passes
Node 8: Process Session — Adjust logic — Passes
Node 9: Save Session to DB — Refreshes expiry — Passes
Node 10: Check Table Set — Confirms table exists locally — Passes
Node 17: Route Action — AI classifies intent as ADD_ITEMS — ADD_ITEMS Branch
Node 21: Parse Item Codes — Plucks item IDs from JSON — Array [IDs]
Node 22: Check Parse Error — Evaluates Array Length — Passes
Node 23: Lookup Items in DB — Verifies Items in PG — DB Records returned
Node 24: Add to Cart — Compiles JSON object — Cart update
Node 25: Update Cart in DB — Modifies user_sessions payload — Updated
Node 26: Confirm Items Added — Tells Customer Via WhatsApp — Meta 200 OK
Terminal: PG cart JSON updated; user receives "Added pizza to your cart!"
Failure points: Node 17 (AI misclassifies -> routes to Send Help), Node 22 (Array zero length -> hits Parse Err trigger).

PATH C — Customer confirms checkout successfully
Trigger: Customer replies "Checkout"
Node 1: WhatsApp Webhook — Captures payload — Emits
Node 2: Validate Environment — Checks setup — Passes
Node 3: Extract Message Data — Maps logic — Passes
Node 4: Sanitize Input — Approves string — Passes
Node 5: Check Sanitization Error — Safe — Passes
Node 7: Load Session from DB — Grabs active cart — Passes
Node 8: Process Session — Adjust logic — Passes
Node 9: Save Session to DB — Updates logic — Passes
Node 10: Check Table Set — Confirms table natively — Passes
Node 17: Route Action — AI classifies intent as CHECKOUT — CHECKOUT Branch
Node 30: Prepare Order — Wraps payload to exact Order structure — JSON output
Node 31: Check Order Error — Validates empty cart limits — Passes
Node 32: Save Order to DB — Fires `orders` INSERT native lock — Passes
Node 33: Clear Cart After Order — Updates session cart to [] natively — Passes
Node 34: Send Order Confirmation — Sends invoice to user — Meta 200 OK
Terminal: User session cart dumped; `orders` table has new order; user gets receipt.
Failure points: Node 31 (Cart was null -> Sends error "Your cart is empty"), Node 32 (Race condition handled via DB -> N8n intercepts SQL Err).

PATH D — Customer sends CANCEL ORDER for a preparing order
Trigger: Customer replies "Cancel my order"
Node 1: WhatsApp Webhook — Listens payload — Passes
Node 2: Validate Environment — Checks ENV — Passes
Node 3: Extract Message Data — Maps logic — Passes
Node 4: Sanitize Input — Approves strings — Passes
Node 5: Check Sanitization Error — Validates safe — Passes
Node 7: Load Session from DB — Retrieves cart bounds — Passes
Node 8: Process Session — Assesses state — Passes
Node 9: Save Session to DB — Refreshes bounds — Passes
Node 10: Check Table Set — Confirms table correctly — Passes
Node 17: Route Action — AI classifies intent as CANCEL — CANCEL Branch
Node 33: Clear Cart After Order — Truncates active JSON bounds natively (or sends error if preparing state handled inside script natively) — Passes
(Alternatively, relies entirely on DB response if "Cancel order" routes directly).
Terminal: Cart completely nullified. User gets "Cart cancelled".
Failure points: Routing misunderstands limit natively.

PATH E — Customer sends DELETE MY DATA with active order
Trigger: Customer asks "Delete my data"
Node 1: WhatsApp Webhook — Listens — Passes
Node 2: Validate Env — Passes
Node 3: Extract Data — Passes
Node 4: Sanitize Logic — Passes
Node 5: Check Error — Passes
Node 7: DB Load — Passes
Node 8: Process — Passes
Node 9: DB Save — Passes
Node 10: Check Table — Passes
Node 17: Route Action — Classifies HELP/GDPR intent — HELP Branch
Node 35: Send Help — Generates GDPR disclaimer and executes internal flags — HTTP
Terminal: DB updates flags, user gets "GDPR instruction registered".
Failure points: Node 35 (Meta unreachable).

PATH F — Groq circuit breaker trips mid-order
Trigger: Customer sends valid message
Node 1: Webhook — Passes
Node 2: Validate Env — Passes
...
Node 17: Route Action — Groq API call is made — TIMEOUT / 500 ERROR
Node 36: Error Trigger — Intercepts unhandled rejection from Node 17
Node 37: Send Global Error — Posts "We are experiencing technical issues"
Terminal: Customer gracefully fails without DB cart corruption.

PATH G — Image message arrives instead of text
Trigger: Inbound Photo
Node 1: Webhook — Passes binary metadata
Node 2: Validate Env — Passes
Node 3: Extract Data — Passes
Node 4: Sanitize Input — Recognizes Format mismatch — Emits Unsafe
Node 5: Check Sanitization Error — Validates boolean — False Branch
Node 6: Send Error Message — Sends limit text natively
Terminal: User immediately gets "I can only read text messages right now."

PATH H — Customer messages outside operating hours
Trigger: Customer messages at 3:00 AM
Node 1: Webhook — Passes
Node 2: Validate Env — Passes
Node 3: Extract Data — Passes
Node 4: Sanitize — Passes
Node 5: Check Sanitize — Passes
Node 7: Load Session — Passes
Node 8: Process Session — Compares `NOW()` to `restaurants.closing_time` — Fails Condition
Node 9: Save Session — Log bounds
Node 10: Check Table — Skip
Node 17: Route Action — Hardcoded closed fallback logic applies explicitly
Terminal: System responds natively "We are currently closed" natively.

PATH I — Customer exceeds rate limit
Trigger: Spam messages arriving rapidly
Node 1: Webhook — Passes
Node 2-5: Sanitize — Passes
Node 7: Load Session / Rate Check — DB function `check_global_rate_limit` evaluated negatively
Node 36: Error Trigger — Intercepts HTTP 429 response native
Node 37: Send Global Error — Ignores implicitly limit or routes rejection efficiently
Terminal: Spam blocked natively.

PATH J — 86'd item found in cart at checkout
Trigger: Customer requests item newly marked unavailable
Node 1-10: Standard validation and state loading
Node 17: Route Action — Intent CHECKOUT
Node 30: Prepare Order — Submits logic array to Orders function
Node 31: Check Order Error — `users_cart_verify` natively rejects JSONB logic mapping Out Of Stock
Node 36: Error Trigger — Intercepts DB rejection bounds
Node 37: Send Global Error / Custom — Customer receives "An item is currently out of stock"
Terminal: No order stored natively.
