import time
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / "mast-lead-engine"
sys.path.insert(0, str(ROOT))

from workers.website_worker import WebsiteWorker

sample_html = """
<!DOCTYPE html>
<html lang="en">
<head>
    <title>Great Coffee Roasters - Specialty Coffee in Austin</title>
    <meta name="description" content="We roast fresh specialty coffee beans in Austin, Texas. Free shipping on orders over $40.">
    <link rel="canonical" href="https://greatcoffee.example.com/">
    <script src="https://www.google-analytics.com/analytics.js"></script>
    <script src="https://cdn.shopify.com/s/files/1/shopify.js"></script>
</head>
<body>
    <header>
        <a href="/">Home</a>
        <a href="/about">About Us</a>
        <a href="/contact">Contact</a>
        <a href="/careers">Join our team - We're hiring!</a>
    </header>
    <main>
        <h1>Welcome to Great Coffee</h1>
        <p>Opening soon in a new location near downtown!</p>
        <p>Check out our latest <a href="/blog/best-brewing-methods">blog post</a></p>
    </main>
    <footer>
        <a href="mailto:info@greatcoffee.example.com">Email us</a>
        <a href="tel:+15125550199">Call us</a>
    </footer>
</body>
</html>
"""

iterations = 10_000

t0 = time.perf_counter()
for _ in range(iterations):
    tech = WebsiteWorker._extract_tech_stack(sample_html, "Shopify")
    growth = WebsiteWorker._extract_growth_signals(sample_html)
t1 = time.perf_counter()

dur_ms = (t1 - t0) * 1000
print(f"Python website_worker signals extraction: {dur_ms:.2f}ms for {iterations} iterations ({(dur_ms/iterations)*1000:.2f}µs/op)")
