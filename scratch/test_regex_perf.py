import re, time

tech_patterns = [
    ("wordpress", "cms", r"wp-content|wp-includes|wordpress"),
    ("squarespace", "cms", r"squarespace\.com|static1\.squarespace\.com|sqsp"),
    ("wix", "cms", r"wix\.com|wixstatic\.com|wix-thunder"),
    ("webflow", "cms", r"webflow\.com|\.webflow\."),
    ("ghost", "cms", r"ghost\.org|ghost\.io"),
    ("shopify", "cms", r"cdn\.shopify\.com|myshopify\.com|shopify\.com/s/"),
    ("framer", "cms", r"framer\.com|framer\.website"),
    ("cargo", "cms", r"cargocollective\.com|cargo\.site"),
    ("format", "cms", r"format\.com"),
    ("woocommerce", "ecom", r"woocommerce|wc-ajax"),
    ("bigcommerce", "ecom", r"bigcommerce\.com"),
    ("magento", "ecom", r"mage|magento"),
    ("prestashop", "ecom", r"prestashop"),
    ("ga4", "analytics", r"gtag\('config'|google-analytics\.com/g/"),
    ("ga_ua", "analytics", r"google-analytics\.com/analytics\.js|UA-\d{6,}"),
    ("gtm", "analytics", r"googletagmanager\.com/gtm\.js"),
    ("hotjar", "analytics", r"hotjar\.com"),
    ("mixpanel", "analytics", r"mixpanel\.com"),
    ("segment", "analytics", r"cdn\.segment\.com"),
    ("clarity", "analytics", r"clarity\.ms"),
    ("heap", "analytics", r"heapanalytics\.com"),
    ("intercom", "chat", r"widget\.intercom\.io"),
    ("drift", "chat", r"js\.driftt\.com|drift\.com"),
    ("zendesk", "chat", r"zdassets\.com|zendesk\.com"),
    ("tawk", "chat", r"tawk\.to"),
    ("hubspot", "crm", r"js\.hs-scripts\.com|hubspot\.com"),
    ("facebook_pixel", "ads", r"connect\.facebook\.net|fbq\("),
    ("tiktok_pixel", "ads", r"analytics\.tiktok\.com"),
    ("pinterest_tag", "ads", r"pintrk\(|pinimg\.com"),
    ("snap_pixel", "ads", r"tr\.snapchat\.com"),
    ("calendly", "booking", r"calendly\.com"),
    ("acuity", "booking", r"acuityscheduling\.com"),
    ("booksy", "booking", r"booksy\.com"),
    ("mindbody", "booking", r"mindbodyonline\.com"),
    ("vagaro", "booking", r"vagaro\.com"),
    ("timely", "booking", r"gettimely\.com"),
    ("fresha", "booking", r"fresha\.com"),
]

compiled = [(t, c, re.compile(p, re.IGNORECASE)) for t, c, p in tech_patterns]
html = '<html><head><script src="https://cdn.shopify.com/s/files/1/shopify.js"></script></head><body><h1>Hello</h1></body></html>' * 10

# Test uncompiled
t0 = time.perf_counter()
for _ in range(5000):
    for t, c, p in tech_patterns:
        re.search(p, html, re.IGNORECASE)
t1 = time.perf_counter()
print(f"Uncompiled: {(t1 - t0)*1000:.2f}ms")

# Test pre-compiled
t0 = time.perf_counter()
for _ in range(5000):
    for t, c, cp in compiled:
        cp.search(html)
t1 = time.perf_counter()
print(f"Pre-compiled: {(t1 - t0)*1000:.2f}ms")
