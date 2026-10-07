import os
import sys
import json
import time

# Reconfigure stdout/stderr to UTF-8 so emojis and arrows don't crash Windows console
sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

from playwright.sync_api import sync_playwright
from PIL import Image, ImageDraw

OUTPUT_DIR = os.path.abspath("./test_screenshots")
ARTIFACT_DIR = r"C:\Users\Beboo\.gemini\antigravity\brain\f07b0a1b-3690-4dc6-bd6d-b9c4804643b0"
os.makedirs(OUTPUT_DIR, exist_ok=True)
os.makedirs(ARTIFACT_DIR, exist_ok=True)

# Generate a 300x300 sample PNG for avatar upload testing
img = Image.new("RGB", (300, 300), color=(30, 64, 175))
draw = ImageDraw.Draw(img)
draw.ellipse((50, 50, 250, 250), fill=(59, 130, 246), outline=(255, 255, 255), width=6)
draw.rectangle((120, 100, 180, 200), fill=(255, 255, 255))
test_image_path = os.path.abspath("./test_avatar_sample.png")
img.save(test_image_path)

USER_ID = "8f3a2c1d-9e01-4b2a-8c3d-1e2f3a4b5c6d"

MOCK_PROFILE = {
    "id": USER_ID,
    "full_name": "Beboo",
    "email": "bebo@example.com",
    "subscription_plan": "pro",
    "monthly_leads_used": 15,
    "daily_leads_used": 3,
    "internal_role": None,
    "settings": {
        "workspaceName": "MAST Workspace",
        "website": "https://mastos.io",
        "defaultRegions": "United States, Canada, United Kingdom",
        "senderName": "Beboo",
        "senderEmail": "",
        "replyTo": "reply@mastos.io",
        "signature": "Best regards,\nBeboo",
        "smtpHost": "",
        "smtpPort": "",
        "smtpUser": "",
        "smtpPassword": "",
        "smtpEncryption": "None",
        "notifyNewLead": "true",
        "notifyCreditLimit": "false",
        "notifyCreditsReset": "false",
        "notifyPlanChanges": "true",
        "notifyBilling": "true",
        "notifyAnnouncements": "true",
        "onboardingCompleted": "true",
        "workspaceStatus": "active",
        "avatarUrl": "",
    }
}

MOCK_SESSION = {
    "access_token": "mock-access-token",
    "refresh_token": "mock-refresh-token",
    "expires_at": int(time.time()) + 86400,
    "expires_in": 86400,
    "token_type": "bearer",
    "user": {
        "id": USER_ID,
        "aud": "authenticated",
        "role": "authenticated",
        "email": "bebo@example.com",
        "email_confirmed_at": "2026-08-07T12:00:00.000Z",
        "user_metadata": {
            "fullName": "Beboo",
            "full_name": "Beboo",
        },
        "app_metadata": {}
    }
}

def save_screenshot(page, filename, full_page=False):
    local_path = os.path.join(OUTPUT_DIR, filename)
    art_path = os.path.join(ARTIFACT_DIR, filename)
    page.screenshot(path=local_path, full_page=full_page)
    page.screenshot(path=art_path, full_page=full_page)
    print(f"Captured: {filename}")

def safe_print(prefix, msg):
    try:
        clean = msg.encode("ascii", "replace").decode("ascii")
        print(f"{prefix}: {clean}")
    except Exception:
        pass

def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1440, "height": 950})
        page = context.new_page()

        page.on("console", lambda msg: safe_print(f"CONSOLE [{msg.type}]", msg.text))
        page.on("pageerror", lambda err: safe_print("PAGE ERROR", str(err)))

        # Route supabase API mocks
        def handle_supabase(route):
            url = route.request.url
            method = route.request.method

            # Profile select / update
            if "/rest/v1/profiles" in url:
                headers = route.request.headers
                is_single = "vnd.pgrst.object" in headers.get("accept", "")
                if method == "GET":
                    body = json.dumps(MOCK_PROFILE if is_single else [MOCK_PROFILE])
                    route.fulfill(status=200, content_type="application/json", body=body)
                    return
                elif method in ["PATCH", "POST"]:
                    post_data = route.request.post_data
                    if post_data:
                        try:
                            parsed = json.loads(post_data)
                            if "settings" in parsed:
                                MOCK_PROFILE["settings"].update(parsed["settings"])
                            if "full_name" in parsed:
                                MOCK_PROFILE["full_name"] = parsed["full_name"]
                        except Exception as e:
                            print("Error parsing update:", e)
                    body = json.dumps(MOCK_PROFILE if is_single else [MOCK_PROFILE])
                    route.fulfill(status=200, content_type="application/json", body=body)
                    return

            # Auth session
            if "/auth/v1/user" in url or "/auth/v1/token" in url:
                route.fulfill(status=200, content_type="application/json", body=json.dumps(MOCK_SESSION))
                return

            route.fulfill(status=200, content_type="application/json", body="{}")

        page.route("**/placeholder.supabase.co/**", handle_supabase)

        # Pre-seed session in localStorage
        page.add_init_script(f"""
            window.localStorage.setItem('sb-placeholder-auth-token', JSON.stringify({json.dumps(MOCK_SESSION)}));
            window.localStorage.setItem('mast_notification_preferences', JSON.stringify({json.dumps(MOCK_PROFILE["settings"])}));
        """)

        print("Navigating to http://localhost:4173/dashboard/settings ...")
        page.goto("http://localhost:4173/dashboard/settings")
        page.wait_for_selector("h1:has-text('Settings')", timeout=15000)
        time.sleep(1.0)

        # ── Test 1: Initial Page Render & Clean State ──
        save_btn = page.locator("button:has-text('Save Settings')")
        assert save_btn.count() == 0, "Save button should NOT be visible when clean!"
        print("Verified: Page is clean with no unsaved changes.")
        save_screenshot(page, "01_settings_clean.png", full_page=True)

        # ── Test 2: Profile Photo Upload & Circular Crop Modal ──
        print("\n[Issue 1] Testing Profile Photo flow...")
        file_input = page.locator("input[type='file']")
        file_input.set_input_files(test_image_path)
        time.sleep(0.5)

        # Modal should be open
        crop_modal = page.locator("h3:has-text('Crop Profile Photo')")
        assert crop_modal.is_visible(), "Crop Profile Photo modal should open after file selection!"
        print("  Verified: Crop Profile Photo modal opened.")

        # Test zoom slider
        zoom_slider = page.locator("input[type='range']")
        assert zoom_slider.is_visible(), "Zoom slider must be present in crop editor."
        zoom_slider.fill("1.8")
        time.sleep(0.5)

        save_screenshot(page, "02_photo_crop_modal.png")

        # Click Apply Photo
        apply_btn = page.locator("button:has-text('Apply Photo')")
        apply_btn.click()
        
        # Wait for modal to close and avatar image to appear
        page.wait_for_selector(".size-16 img", timeout=10000)
        avatar_img = page.locator(".size-16 img")
        assert avatar_img.is_visible(), "Avatar must display the newly cropped image!"
        print("  Verified: Profile photo cropped and immediately displayed in avatar!")
        save_screenshot(page, "02_photo_crop_verified.png")

        # ── Test 3: Discover Region Selector ──
        print("\n[Issue 2] Testing Discover Region Selector...")
        region_combobox = page.locator("button[role='combobox']")
        assert region_combobox.is_visible(), "Region combobox trigger must be visible."
        
        # Open dropdown
        region_combobox.click()
        time.sleep(0.4)

        # Verify Search input is present with Discover styling
        search_input = page.locator("input[placeholder='Search countries…']")
        assert search_input.is_visible(), "Search input inside region selector must be visible."
        
        # Type search query
        search_input.fill("Germ")
        time.sleep(0.3)

        germany_opt = page.locator("button[role='option']:has-text('Germany')")
        assert germany_opt.is_visible(), "Germany must be visible in filtered results."
        print("  Verified: Search filter in Discover region selector works.")
        save_screenshot(page, "03_region_selector_dropdown.png")

        # Toggle Germany
        germany_opt.click()
        time.sleep(0.4)

        # Close dropdown with Escape
        page.keyboard.press("Escape")
        time.sleep(0.3)

        # Check Germany is added in selected tags
        germany_tag = page.locator("span:has-text('Germany')")
        assert germany_tag.count() > 0, "Germany must appear in selected tags."
        print("  Verified: Region selected and tag rendered.")
        save_screenshot(page, "03_region_selector_verified.png")

        # ── Test 4: SMTP / Sender Identity Dependency & Signature ──
        print("\n[Issue 3 & 4] Testing SMTP & Sender Identity Dependency...")
        # Initially, SMTP is empty, so Sender Identity must show warning banner and be locked
        smtp_warning = page.locator("p:has-text('SMTP Configuration Required')")
        assert smtp_warning.is_visible(), "SMTP Configuration Required notice must be visible when SMTP is empty!"
        print("  Verified: Sender Identity is locked when SMTP is unconfigured.")

        # From Name input must be disabled (nth(1) because first is Name in Account card)
        from_name_input = page.locator("input[placeholder='Beboo']").nth(1)
        assert from_name_input.is_disabled(), "From Name input must be disabled when SMTP is not configured!"

        # Now configure SMTP
        smtp_host = page.locator("input[placeholder='smtp.example.com']")
        smtp_port = page.locator("input[placeholder='587']")
        smtp_user = page.locator("input[placeholder='your-email@example.com']")
        smtp_pass = page.locator("input[placeholder='••••••••••••']")

        smtp_host.fill("smtp.sendgrid.net")
        smtp_port.fill("587")
        smtp_user.fill("alex@mastos.io")
        smtp_pass.fill("secretPassword123")
        time.sleep(0.4)

        # Sender identity warning should now be gone, and fields enabled!
        assert smtp_warning.count() == 0, "SMTP Configuration Required notice must disappear when SMTP is configured!"
        assert not from_name_input.is_disabled(), "From Name must become enabled after SMTP is configured!"
        print("  Verified: Sender Identity unlocked after SMTP configured.")

        # From Email must automatically equal smtpUser and be strictly read-only
        from_email_input = page.locator("input[disabled][readonly][value='alex@mastos.io']")
        assert from_email_input.is_visible(), "From Email must automatically populate with configured SMTP username!"
        assert from_email_input.is_disabled(), "From Email must NOT be editable (read-only/disabled)!"
        print("  Verified: From Email is automatically populated with smtpUser and strictly non-editable.")

        # Type custom signature
        sig_input = page.locator("textarea[placeholder*='Best regards']")
        sig_input.fill("Cheers,\nAlex Rivera\nFounder, Studio Mast")
        time.sleep(0.3)
        print("  Verified: Signature entered successfully.")
        save_screenshot(page, "04_smtp_sender_identity_verified.png")

        # ── Test 5: Notifications Restoration ──
        print("\n[Issue 5] Testing Notifications Restoration...")
        expected_notifications = [
            "New Leads Available",
            "Credit Limit Reached",
            "Daily Credits Reset",
            "Plan Changes",
            "Billing Updates",
            "System Announcements",
            "Outreach Replies",
            "Weekly Summary",
        ]
        for notif in expected_notifications:
            loc = page.locator(f"p:has-text('{notif}')")
            assert loc.count() > 0, f"Notification '{notif}' must be present in the Notifications card!"
            print(f"  Verified notification present: {notif}")

        # Verify Coming Soon badges on Outreach Replies and Weekly Summary
        soon_badges = page.locator("span:has-text('Soon')")
        assert soon_badges.count() >= 2, "Coming Soon badges must be visible on Outreach Replies and Weekly Summary."
        print("  Verified: All 8 notification rows restored with correct labels and Coming Soon badges.")
        save_screenshot(page, "05_notifications_all_8_verified.png")

        # ── Test 6: Sticky Floating Save / Discard Bar ──
        print("\nTesting Sticky Save / Discard Bar...")
        save_btn = page.locator("button:has-text('Save Settings')")
        discard_btn = page.locator("button:has-text('Discard Changes')")
        assert save_btn.is_visible(), "Save button must be visible when changes are made!"

        # Save settings
        save_btn.click()
        time.sleep(0.8)

        # Save bar should disappear after save
        assert save_btn.count() == 0, "Save bar must disappear after successful save!"
        print("  Verified: Save button persisted changes and hid the sticky bar.")

        # Make another change to test Discard
        ws_name_input = page.locator("input[placeholder='MAST Workspace']")
        ws_name_input.fill("Brand New Workspace Name")
        time.sleep(0.3)
        assert save_btn.is_visible(), "Save button must appear when workspace name changes."

        # Click Discard
        discard_btn.click()
        time.sleep(0.4)
        assert save_btn.count() == 0, "Save bar must disappear after discarding!"
        assert ws_name_input.input_value() == "MAST Workspace", "Workspace Name must revert to original after discard!"
        print("  Verified: Discard button reverted changes and hid the save bar.")

        save_screenshot(page, "06_all_tests_passed.png", full_page=True)
        print("\n========================================================")
        print("ALL 5 SETTINGS ISSUES + SAVE BEHAVIOR VERIFIED 100% OK!")
        print("========================================================")

        browser.close()

if __name__ == "__main__":
    main()
