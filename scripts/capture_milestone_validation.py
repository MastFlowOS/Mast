import os
import shutil
import time
from playwright.sync_api import sync_playwright

def main():
    output_dir = os.path.abspath("./milestone_validation_screenshots")
    artifact_dir = r"C:\Users\Beboo\.gemini\antigravity\brain\2f019e90-e8e9-483b-8718-e8559d6f4d67"
    os.makedirs(output_dir, exist_ok=True)
    os.makedirs(artifact_dir, exist_ok=True)

    with sync_playwright() as p:
        browser = p.chromium.launch()
        
        # 1. Capture 4 Time of Day States on Desktop (1280x800)
        periods = ["morning", "afternoon", "evening", "night"]
        page = browser.new_page(viewport={"width": 1280, "height": 900})
        page.goto("http://localhost:5173/milestone-preview", wait_until="networkidle")
        page.wait_for_timeout(1000)

        for period in periods:
            print(f"Setting time of day to {period}...")
            # Click exact period button
            page.get_by_role("button", name=period.capitalize(), exact=True).click()
            page.wait_for_timeout(600)

            # Check overflow
            overflow = page.evaluate("() => document.documentElement.scrollWidth > window.innerWidth")
            print(f"  [{period}] Overflow: {overflow}")

            filename = f"milestone_{period}_desktop.png"
            filepath = os.path.join(output_dir, filename)
            
            # Screenshot the journey card
            card = page.locator(".focus-milestone-journey-section")
            card.screenshot(path=filepath)
            print(f"  Saved: {filepath}")
            shutil.copy2(filepath, os.path.join(artifact_dir, filename))

        # 2. Capture XP Progressions (100 XP, 150 XP, 200 XP, 250 XP) in Night mode (matching Image 1)
        page.get_by_role("button", name="Night", exact=True).click()
        page.wait_for_timeout(300)

        xp_levels = [
            ("100xp", "100 XP"),
            ("150xp", "150 XP"),
            ("200xp", "200 XP"),
            ("250xp", "250 XP"),
        ]

        for code, btn_text in xp_levels:
            print(f"Setting XP to {btn_text}...")
            page.get_by_role("button", name=btn_text, exact=False).first.click()
            page.wait_for_timeout(400)

            filename = f"milestone_progress_{code}.png"
            filepath = os.path.join(output_dir, filename)
            card = page.locator(".focus-milestone-journey-section")
            card.screenshot(path=filepath)
            print(f"  Saved: {filepath}")
            shutil.copy2(filepath, os.path.join(artifact_dir, filename))

        page.close()

        # 3. Capture Tablet (768px) and Mobile (390px)
        responsive_tests = [
            {"name": "tablet_768px", "width": 768, "height": 1024},
            {"name": "mobile_390px", "width": 390, "height": 844},
        ]

        for rt in responsive_tests:
            resp_page = browser.new_page(viewport={"width": rt["width"], "height": rt["height"]})
            resp_page.goto("http://localhost:5173/milestone-preview", wait_until="networkidle")
            resp_page.wait_for_timeout(800)

            # Switch to night to match Image 1
            resp_page.get_by_role("button", name="Night", exact=True).click()
            resp_page.wait_for_timeout(400)

            overflow = resp_page.evaluate("() => document.documentElement.scrollWidth > window.innerWidth")
            print(f"[{rt['name']}] Horizontal overflow: {overflow}")

            filename = f"milestone_{rt['name']}.png"
            filepath = os.path.join(output_dir, filename)
            card = resp_page.locator(".focus-milestone-journey-section")
            card.screenshot(path=filepath)
            print(f"  Saved: {filepath}")
            shutil.copy2(filepath, os.path.join(artifact_dir, filename))

            resp_page.close()

        browser.close()
    print("All validation screenshots captured successfully!")

if __name__ == "__main__":
    main()
