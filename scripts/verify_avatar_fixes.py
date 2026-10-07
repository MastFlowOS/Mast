import os
import sys
import json
import time

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

from playwright.sync_api import sync_playwright
from PIL import Image, ImageDraw

OUTPUT_DIR = os.path.abspath("./test_screenshots")
ARTIFACT_DIR = r"C:\Users\Beboo\.gemini\antigravity\brain\23ab17e1-bb63-47e3-a2b6-309cd0afaca4"
os.makedirs(OUTPUT_DIR, exist_ok=True)
os.makedirs(ARTIFACT_DIR, exist_ok=True)

# Generate a 300x300 test photo with distinct colors and shapes
img = Image.new("RGB", (300, 300), color=(16, 185, 129)) # emerald
draw = ImageDraw.Draw(img)
draw.ellipse((40, 40, 260, 260), fill=(245, 158, 11), outline=(255, 255, 255), width=8) # amber circle
draw.rectangle((100, 100, 200, 200), fill=(99, 102, 241)) # indigo square
test_image_path = os.path.abspath("./test_avatar_verify.png")
img.save(test_image_path)

USER_ID = "8f3a2c1d-9e01-4b2a-8c3d-1e2f3a4b5c6d"

MOCK_PROFILE = {
    "id": USER_ID,
    "full_name": "Isaac Newton",
    "email": "isaac@example.com",
    "subscription_plan": "pro",
    "monthly_leads_used": 15,
    "daily_leads_used": 3,
    "internal_role": None,
    "settings": {
        "workspaceName": "MAST Workspace",
        "website": "https://mastos.io",
        "defaultRegions": "United States",
        "senderName": "Isaac Newton",
        "senderEmail": "",
        "replyTo": "reply@mastos.io",
        "signature": "Best regards,\nIsaac",
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
        "avatarUrl": None,
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
        "email": "isaac@example.com",
        "email_confirmed_at": "2026-08-07T12:00:00.000Z",
        "user_metadata": {
            "fullName": "Isaac Newton",
            "full_name": "Isaac Newton",
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

def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1440, "height": 950})
        page = context.new_page()

        page.on("console", lambda msg: print(f"CONSOLE [{msg.type}]: {msg.text}") if "error" in msg.type.lower() else None)
        page.on("pageerror", lambda err: print(f"PAGE ERROR: {err}"))

        def handle_supabase(route):
            url = route.request.url
            method = route.request.method

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

            if "/auth/v1/user" in url or "/auth/v1/token" in url:
                route.fulfill(status=200, content_type="application/json", body=json.dumps(MOCK_SESSION))
                return

            route.fulfill(status=200, content_type="application/json", body="{}")

        page.route("**/placeholder.supabase.co/**", handle_supabase)

        page.add_init_script(f"""
            window.localStorage.setItem('sb-placeholder-auth-token', JSON.stringify({json.dumps(MOCK_SESSION)}));
            window.localStorage.setItem('mast_notification_preferences', JSON.stringify({json.dumps(MOCK_PROFILE["settings"])}));
        """)

        print("Navigating to http://localhost:4173/dashboard/settings ...")
        page.goto("http://localhost:4173/dashboard/settings")
        page.wait_for_selector("h1:has-text('Settings')", timeout=15000)
        time.sleep(1.0)

        # ── Step 1: Initial state before upload ──
        # Account avatar should show initial "I"
        account_initial = page.locator(".size-16:has-text('I')")
        assert account_initial.is_visible(), "Account avatar should show initial 'I' when no avatarUrl!"
        
        # Navbar avatar should show initial "IN" or "I"
        navbar_avatar = page.locator("header .size-9.rounded-full")
        assert navbar_avatar.is_visible(), "Navbar avatar container must be visible!"
        assert "I" in navbar_avatar.text_content(), f"Navbar avatar should show initial 'I', got: {navbar_avatar.text_content()}"

        # Sidebar avatar should show initial "IN" or "I"
        sidebar_avatar = page.locator("aside .size-8.rounded-full")
        assert sidebar_avatar.is_visible(), "Sidebar avatar container must be visible!"
        assert "I" in sidebar_avatar.text_content(), f"Sidebar avatar should show initial 'I', got: {sidebar_avatar.text_content()}"
        print("PASS: Initial state before upload has initials fallback in all 3 avatars.")
        save_screenshot(page, "01_before_photo_upload.png")

        # ── Step 2: Upload photo and crop ──
        print("Uploading photo...")
        file_input = page.locator("input[type='file']")
        file_input.set_input_files(test_image_path)
        time.sleep(0.5)

        crop_modal = page.locator("h3:has-text('Crop Profile Photo')")
        assert crop_modal.is_visible(), "Crop Profile Photo modal should open!"
        save_screenshot(page, "02_crop_modal_open.png")

        apply_btn = page.locator("button:has-text('Apply Photo')")
        apply_btn.click()

        # Wait for modal to close
        page.wait_for_selector("h3:has-text('Crop Profile Photo')", state="detached", timeout=10000)
        time.sleep(1.0)

        # ── Step 3: IMMEDIATELY verify without page reload ──
        print("Verifying immediate avatar propagation without page refresh...")

        # A. Account avatar in Settings
        account_img = page.locator(".size-16 img")
        assert account_img.is_visible(), "Account avatar must show <img> immediately!"
        account_src = account_img.get_attribute("src")
        assert account_src and account_src.startswith("data:image/jpeg;base64,"), "Account avatar must be valid data URL!"

        # B. Top-right navbar avatar
        navbar_img = page.locator("header .size-9.rounded-full img")
        assert navbar_img.is_visible(), "Top-right navbar avatar MUST show <img> immediately without refresh!"
        navbar_src = navbar_img.get_attribute("src")
        assert navbar_src == account_src, f"Navbar avatar src ({navbar_src[:30]}...) must match Account avatar src ({account_src[:30]}...)!"
        assert "I" not in page.locator("header .size-9.rounded-full").text_content(), "Navbar avatar must NOT display initials text anymore!"

        # C. Bottom-left sidebar avatar
        sidebar_img = page.locator("aside .size-8.rounded-full img")
        assert sidebar_img.is_visible(), "Bottom-left sidebar avatar MUST show <img> immediately without refresh!"
        sidebar_src = sidebar_img.get_attribute("src")
        assert sidebar_src == account_src, f"Sidebar avatar src ({sidebar_src[:30]}...) must match Account avatar src ({account_src[:30]}...)!"
        assert "I" not in page.locator("aside .size-8.rounded-full").text_content(), "Sidebar avatar must NOT display initials text anymore!"

        # Check CSS and dimensions on sidebar avatar
        sidebar_box = sidebar_avatar.bounding_box()
        sidebar_img_box = sidebar_img.bounding_box()
        print(f"Sidebar container box: {sidebar_box}")
        print(f"Sidebar img box: {sidebar_img_box}")

        assert sidebar_box["width"] == 32.0, f"Sidebar container width should be 32px, got {sidebar_box['width']}"
        assert sidebar_box["height"] == 32.0, f"Sidebar container height should be 32px, got {sidebar_box['height']}"
        # The image fills the entire container (30px inner content box within 1px border-box, or 32px)
        assert sidebar_img_box["width"] >= 30.0 and sidebar_img_box["width"] <= 32.5, f"Sidebar image width should fill container, got {sidebar_img_box['width']}"
        assert sidebar_img_box["height"] >= 30.0 and sidebar_img_box["height"] <= 32.5, f"Sidebar image height should fill container, got {sidebar_img_box['height']}"

        sidebar_img_styles = sidebar_img.evaluate("""el => {
            const cs = window.getComputedStyle(el);
            return {
                objectFit: cs.objectFit,
                objectPosition: cs.objectPosition,
                width: cs.width,
                height: cs.height,
            };
        }""")
        print(f"Sidebar img computed styles: {sidebar_img_styles}")
        assert sidebar_img_styles["objectFit"] == "cover", f"object-fit must be cover, got {sidebar_img_styles['objectFit']}"

        navbar_img_styles = navbar_img.evaluate("""el => {
            const cs = window.getComputedStyle(el);
            return {
                objectFit: cs.objectFit,
                objectPosition: cs.objectPosition,
                width: cs.width,
                height: cs.height,
            };
        }""")
        print(f"Navbar img computed styles: {navbar_img_styles}")
        assert navbar_img_styles["objectFit"] == "cover", f"Navbar object-fit must be cover, got {navbar_img_styles['objectFit']}"

        save_screenshot(page, "03_immediate_propagation_verified.png")
        print("PASS: Immediate propagation verified across Account, Navbar, and Sidebar!")

        # ── Step 4: Full page reload verification ──
        print("\nReloading page to verify persistence after refresh...")
        page.reload()
        page.wait_for_selector("h1:has-text('Settings')", timeout=15000)
        time.sleep(1.0)

        # Re-check all three avatars after reload
        account_img_reload = page.locator(".size-16 img")
        assert account_img_reload.is_visible(), "Account avatar must still show <img> after reload!"
        assert account_img_reload.get_attribute("src") == account_src

        navbar_img_reload = page.locator("header .size-9.rounded-full img")
        assert navbar_img_reload.is_visible(), "Top-right navbar avatar must still show <img> after reload!"
        assert navbar_img_reload.get_attribute("src") == account_src
        assert "I" not in page.locator("header .size-9.rounded-full").text_content(), "No initials should remain in navbar after reload!"

        sidebar_img_reload = page.locator("aside .size-8.rounded-full img")
        assert sidebar_img_reload.is_visible(), "Bottom-left sidebar avatar must still show <img> after reload!"
        assert sidebar_img_reload.get_attribute("src") == account_src
        assert "I" not in page.locator("aside .size-8.rounded-full").text_content(), "No initials should remain in sidebar after reload!"

        save_screenshot(page, "04_after_page_reload_verified.png")
        print("PASS: Full reload verification passed! All 3 avatars persisted and match.")

        print("\n==================================================================")
        print("ALL VERIFICATIONS COMPLETED SUCCESSFULLY!")
        print("==================================================================")

        browser.close()

if __name__ == "__main__":
    main()
