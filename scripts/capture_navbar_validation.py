import os
import shutil
import time
from playwright.sync_api import sync_playwright

def main():
    output_dir = os.path.abspath("./navbar_validation_screenshots")
    artifact_dir = r"C:\Users\Beboo\.gemini\antigravity\brain\7664026c-a20e-4706-852d-bdb6bc63fca1"
    os.makedirs(output_dir, exist_ok=True)
    
    viewports = [
        {"name": "desktop_1536px", "width": 1536, "height": 900},
        {"name": "tablet_768px", "width": 768, "height": 1024},
        {"name": "mobile_390px", "width": 390, "height": 844},
    ]

    scroll_positions = [
        {"name": "top_0px", "y": 0},
        {"name": "scroll_100px", "y": 100},
        {"name": "scroll_500px", "y": 500},
    ]

    with sync_playwright() as p:
        browser = p.chromium.launch()
        
        for vp in viewports:
            page = browser.new_page(viewport={"width": vp["width"], "height": vp["height"]})
            print(f"Loading page for {vp['name']}...")
            page.goto("http://localhost:4173/", wait_until="networkidle")
            page.wait_for_timeout(1000)

            for sp in scroll_positions:
                print(f"Scrolling {vp['name']} to y={sp['y']}...")
                page.evaluate(f"window.scrollTo(0, {sp['y']})")
                page.wait_for_timeout(700) # allow 500ms transition to settle fully

                overflow = page.evaluate("() => document.documentElement.scrollWidth > window.innerWidth")
                print(f"  [{vp['name']} - {sp['name']}] Horizontal overflow: {overflow}")

                filename = f"nav_{vp['name']}_{sp['name']}.png"
                filepath = os.path.join(output_dir, filename)
                
                # Capture the top 350px where navbar and hero transition are clearly visible
                page.screenshot(path=filepath, clip={"x": 0, "y": 0, "width": vp["width"], "height": min(vp["height"], 380)})
                print(f"  Saved: {filepath}")

                # Copy to artifact dir
                artifact_path = os.path.join(artifact_dir, filename)
                shutil.copy2(filepath, artifact_path)

            page.close()
        
        browser.close()
    print("All validation screenshots captured successfully!")

if __name__ == "__main__":
    main()
