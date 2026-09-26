import time
from playwright.sync_api import sync_playwright

def validate():
    with sync_playwright() as p:
        browser = p.chromium.launch()
        
        # 1. Desktop Validation
        page = browser.new_page(viewport={"width": 1536, "height": 900})
        errors = []
        page.on("console", lambda msg: errors.append(msg.text) if msg.type == "error" else None)
        page.on("pageerror", lambda err: errors.append(str(err)))

        requests = []
        page.on("request", lambda r: requests.append(r.url))

        page.goto("http://localhost:4173/", wait_until="networkidle")
        page.wait_for_timeout(1000)

        # Video properties
        vid_info = page.evaluate("""() => {
            const v = document.querySelector('video');
            if (!v) return null;
            return {
                src: v.currentSrc,
                paused: v.paused,
                muted: v.muted,
                loop: v.loop,
                playsInline: v.playsInline,
                currentTime: v.currentTime,
                duration: v.duration,
                videoWidth: v.videoWidth,
                videoHeight: v.videoHeight
            };
        }""")
        print("Video info:", vid_info)

        # Verify playback over at least 2 full loops (6.4s * 2 = 12.8s)
        print("Observing playback over 2 full loops (13.5s)...")
        sample_times = []
        for _ in range(27):
            t = page.evaluate("() => { const v = document.querySelector('video'); return v ? v.currentTime : -1; }")
            sample_times.append(round(t, 2))
            page.wait_for_timeout(500)
        
        print("Playback time progression samples (every 500ms):")
        print(sample_times)

        # Desktop screenshot
        overflow_desk = page.evaluate("() => document.documentElement.scrollWidth > window.innerWidth")
        page.screenshot(path="validate_desktop_1536.png")
        print("Desktop overflow:", overflow_desk)

        # 2. Tablet Validation (768px)
        page.set_viewport_size({"width": 768, "height": 1024})
        page.wait_for_timeout(1000)
        overflow_tab = page.evaluate("() => document.documentElement.scrollWidth > window.innerWidth")
        page.screenshot(path="validate_tablet_768.png")
        print("Tablet overflow:", overflow_tab)

        # 3. Mobile Validation (390px)
        page.set_viewport_size({"width": 390, "height": 844})
        page.wait_for_timeout(1000)
        overflow_mob = page.evaluate("() => document.documentElement.scrollWidth > window.innerWidth")
        page.screenshot(path="validate_mobile_390.png")
        print("Mobile overflow:", overflow_mob)

        # Check requests
        webm_reqs = [r for r in requests if "mast-gold-flow-animated.webm" in r]
        png_reqs = [r for r in requests if "mast-gold-flow.png" in r]
        print(f"WebM requests: {len(webm_reqs)}, Static PNG requests: {len(png_reqs)}")
        print(f"Console errors: {len(errors)}")

        # 4. Reduced Motion Validation
        ctx_rm = browser.new_context(reduced_motion="reduce", viewport={"width": 1536, "height": 900})
        page_rm = ctx_rm.new_page()
        rm_reqs = []
        page_rm.on("request", lambda r: rm_reqs.append(r.url))
        page_rm.goto("http://localhost:4173/", wait_until="networkidle")
        page_rm.wait_for_timeout(1000)

        rm_has_video = page_rm.evaluate("() => !!document.querySelector('video')")
        rm_has_img = page_rm.evaluate("() => !!document.querySelector('img[src*=\"mast-gold-flow.png\"]')")
        rm_webm_reqs = [r for r in rm_reqs if "mast-gold-flow-animated.webm" in r]
        rm_png_reqs = [r for r in rm_reqs if "mast-gold-flow.png" in r]

        print("Reduced motion - Has video element in DOM:", rm_has_video)
        print("Reduced motion - Has static PNG img in DOM:", rm_has_img)
        print(f"Reduced motion - WebM requests: {len(rm_webm_reqs)}, PNG requests: {len(rm_png_reqs)}")

        browser.close()

if __name__ == "__main__":
    validate()
