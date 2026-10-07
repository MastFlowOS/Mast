import os
import sys
import json
import time

# Ensure Windows console handles utf-8 output cleanly
sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

from playwright.sync_api import sync_playwright

ARTIFACT_DIR = r"C:\Users\Beboo\.gemini\antigravity\brain\f07b0a1b-3690-4dc6-bd6d-b9c4804643b0"
os.makedirs(ARTIFACT_DIR, exist_ok=True)

USER_ID = "8f3a2c1d-9e01-4b2a-8c3d-1e2f3a4b5c6d"

def create_mock_profile(smtp_configured: bool):
    if smtp_configured:
        smtp_data = {
            "smtpHost": "smtp.mailgun.org",
            "smtpPort": "587",
            "smtpUser": "relay@mailgun.mastos.io",
            "smtpPassword": "secret-smtp-password",
            "smtpEncryption": "TLS",
            "senderEmail": "relay@mailgun.mastos.io",
            "smtpSenderEmail": "relay@mailgun.mastos.io",
        }
    else:
        smtp_data = {
            "smtpHost": "",
            "smtpPort": "",
            "smtpUser": "",
            "smtpPassword": "",
            "smtpEncryption": "None",
            "senderEmail": "founder@myagency.com",
            "smtpSenderEmail": "",
        }

    return {
        "id": USER_ID,
        "full_name": "Alex Mercer",
        "email": "alex@mastos.io",
        "subscription_plan": "pro",
        "monthly_leads_used": 10,
        "daily_leads_used": 2,
        "internal_role": None,
        "settings": {
            "workspaceName": "Mercer Growth Studio",
            "website": "https://mercergrowth.com",
            "defaultRegions": "United States, Canada",
            "senderName": "Alex Mercer",
            "replyTo": "alex@mercergrowth.com",
            "signature": "Best regards,\nAlex Mercer\nFounder, Mercer Growth",
            "notifyNewLead": "true",
            "notifyCreditLimit": "false",
            "notifyCreditsReset": "false",
            "notifyPlanChanges": "true",
            "notifyBilling": "true",
            "notifyAnnouncements": "true",
            "onboardingCompleted": "true",
            "workspaceStatus": "active",
            **smtp_data,
        }
    }

MOCK_SESSION = {
    "access_token": "mock-token",
    "refresh_token": "mock-refresh",
    "expires_at": int(time.time()) + 86400,
    "expires_in": 86400,
    "token_type": "bearer",
    "user": {
        "id": USER_ID,
        "aud": "authenticated",
        "role": "authenticated",
        "email": "alex@mastos.io",
        "email_confirmed_at": "2026-08-07T12:00:00.000Z",
        "user_metadata": {
            "fullName": "Alex Mercer",
            "full_name": "Alex Mercer",
        },
        "app_metadata": {}
    }
}

def run_test():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)

        # ══════════════════════════════════════════════════════════════════
        # TEST STATE A: SMTP CONFIGURED
        # ══════════════════════════════════════════════════════════════════
        print("\n--- [STATE A] Testing with SMTP Configured ---")
        mock_a = create_mock_profile(smtp_configured=True)
        ctx_a = browser.new_context(viewport={"width": 1440, "height": 950})
        page_a = ctx_a.new_page()

        def handle_supabase_a(route):
            url = route.request.url
            method = route.request.method
            if "/rest/v1/profiles" in url:
                headers = route.request.headers
                is_single = "vnd.pgrst.object" in headers.get("accept", "")
                if method == "GET":
                    route.fulfill(status=200, content_type="application/json", body=json.dumps(mock_a if is_single else [mock_a]))
                    return
                elif method in ["PATCH", "POST"]:
                    post_data = route.request.post_data
                    if post_data:
                        parsed = json.loads(post_data)
                        if "settings" in parsed:
                            mock_a["settings"].update(parsed["settings"])
                    route.fulfill(status=200, content_type="application/json", body=json.dumps(mock_a if is_single else [mock_a]))
                    return
            if "/auth/v1/user" in url or "/auth/v1/token" in url:
                route.fulfill(status=200, content_type="application/json", body=json.dumps(MOCK_SESSION))
                return
            route.fulfill(status=200, content_type="application/json", body="{}")

        page_a.route("**/placeholder.supabase.co/**", handle_supabase_a)
        page_a.add_init_script(f"""
            window.localStorage.setItem('sb-placeholder-auth-token', JSON.stringify({json.dumps(MOCK_SESSION)}));
        """)

        page_a.goto("http://localhost:4173/dashboard/settings")
        page_a.wait_for_selector("h1:has-text('Settings')", timeout=15000)
        time.sleep(1.0)

        # 1. Verify NO "SMTP Configuration Required" lock banner
        banner_a = page_a.locator("text='SMTP Configuration Required'")
        assert banner_a.count() == 0, "No lock banner should exist in State A!"
        print("  ✓ Verified: No SMTP warning banner displayed.")

        # 2. Verify Sender Identity Card fields
        # From Name is editable
        from_name_a = page_a.locator("label:has-text('From Name') input")
        assert from_name_a.is_enabled(), "From Name must be editable."
        assert from_name_a.input_value() == "Alex Mercer", f"Expected 'Alex Mercer', got {from_name_a.input_value()}"
        print("  ✓ Verified: From Name is editable ('Alex Mercer').")

        # From Email is read-only and locked to SMTP user
        from_email_a = page_a.locator("input[readonly][disabled]")
        assert from_email_a.count() >= 1, "From Email must be read-only and disabled when SMTP is configured."
        smtp_user_input = page_a.locator("input[value='relay@mailgun.mastos.io']")
        assert smtp_user_input.count() >= 2, "SMTP user should appear in both SMTP configuration and From Email."
        
        # Verify Auto-populated badge is visible
        badge_a = page_a.locator("text='Auto-populated from SMTP'")
        assert badge_a.is_visible(), "Badge 'Auto-populated from SMTP' must be visible."
        print("  ✓ Verified: From Email is read-only, locked to SMTP user ('relay@mailgun.mastos.io') with lock badge.")

        # Signature is editable
        sig_a = page_a.locator("textarea")
        assert sig_a.is_enabled(), "Signature textarea must be editable."
        assert "Alex Mercer" in sig_a.input_value(), "Signature must contain saved signature."
        print("  ✓ Verified: Signature is editable and populated.")

        page_a.screenshot(path=os.path.join(ARTIFACT_DIR, "01_smtp_configured_locked_email.png"), full_page=True)
        print("  ✓ Captured: 01_smtp_configured_locked_email.png")
        ctx_a.close()

        # ══════════════════════════════════════════════════════════════════
        # TEST STATE B: SMTP NOT CONFIGURED
        # ══════════════════════════════════════════════════════════════════
        print("\n--- [STATE B] Testing with SMTP NOT Configured ---")
        mock_b = create_mock_profile(smtp_configured=False)
        ctx_b = browser.new_context(viewport={"width": 1440, "height": 950})
        page_b = ctx_b.new_page()

        last_patch_payload = {}

        def handle_supabase_b(route):
            nonlocal last_patch_payload
            url = route.request.url
            method = route.request.method
            if "/rest/v1/profiles" in url:
                headers = route.request.headers
                is_single = "vnd.pgrst.object" in headers.get("accept", "")
                if method == "GET":
                    route.fulfill(status=200, content_type="application/json", body=json.dumps(mock_b if is_single else [mock_b]))
                    return
                elif method in ["PATCH", "POST"]:
                    post_data = route.request.post_data
                    if post_data:
                        parsed = json.loads(post_data)
                        last_patch_payload = parsed
                        if "settings" in parsed:
                            mock_b["settings"].update(parsed["settings"])
                    route.fulfill(status=200, content_type="application/json", body=json.dumps(mock_b if is_single else [mock_b]))
                    return
            if "/auth/v1/user" in url or "/auth/v1/token" in url:
                route.fulfill(status=200, content_type="application/json", body=json.dumps(MOCK_SESSION))
                return
            route.fulfill(status=200, content_type="application/json", body="{}")

        page_b.route("**/placeholder.supabase.co/**", handle_supabase_b)
        page_b.add_init_script(f"""
            window.localStorage.setItem('sb-placeholder-auth-token', JSON.stringify({json.dumps(MOCK_SESSION)}));
        """)

        page_b.goto("http://localhost:4173/dashboard/settings")
        page_b.wait_for_selector("h1:has-text('Settings')", timeout=15000)
        time.sleep(1.0)

        # 1. Verify NO "SMTP Configuration Required" lock banner
        banner_b = page_b.locator("text='SMTP Configuration Required'")
        assert banner_b.count() == 0, "No lock banner should exist in State B!"
        print("  ✓ Verified: No SMTP warning banner displayed.")

        # 2. Verify Sender Identity is NOT disabled or reduced opacity
        sender_card = page_b.locator("div:has(> h2:has-text('Sender Identity')), div:has(h3:has-text('Sender Identity'))").first
        # Find From Email input in Sender Identity
        from_email_input_b = page_b.locator("div:has(> span:has-text('From Email')) input, label:has-text('From Email') input")
        assert from_email_input_b.count() >= 1, "From Email input must exist."
        
        # Verify it is EDITABLE (not disabled, not read-only)
        assert from_email_input_b.is_enabled(), "From Email MUST be enabled when SMTP is not configured!"
        assert not from_email_input_b.is_editable() is False, "From Email MUST be editable!"
        assert from_email_input_b.input_value() == "founder@myagency.com", f"Expected 'founder@myagency.com', got {from_email_input_b.input_value()}"
        print("  ✓ Verified: From Email is fully editable with initial value 'founder@myagency.com'.")

        # Verify Auto-populated badge is NOT visible
        badge_b = page_b.locator("text='Auto-populated from SMTP'")
        assert badge_b.count() == 0, "Badge 'Auto-populated from SMTP' must NOT be visible when SMTP is unconfigured."
        print("  ✓ Verified: Auto-populated from SMTP badge is hidden.")

        # 3. Test Editing From Email
        print("  Editing From Email to 'growth@newagency.io'...")
        from_email_input_b.fill("growth@newagency.io")
        time.sleep(0.3)

        # 4. Verify Sticky Save Bar appears immediately
        save_bar = page_b.locator("button:has-text('Save Settings')")
        assert save_bar.is_visible(), "Sticky Save Settings button must appear when From Email is edited!"
        print("  ✓ Verified: Sticky Save / Discard control appeared immediately on edit.")

        page_b.screenshot(path=os.path.join(ARTIFACT_DIR, "02_smtp_unconfigured_editable_email.png"), full_page=True)
        print("  ✓ Captured: 02_smtp_unconfigured_editable_email.png")

        # 5. Click Save Settings and verify payload persistence
        print("  Clicking Save Settings...")
        save_bar.click()
        time.sleep(0.8)

        # Verify sticky bar hides after saving
        assert save_bar.count() == 0, "Sticky save bar must hide after successful save!"
        print("  ✓ Verified: Save bar disappeared after save.")

        # Verify backend payload received the edited senderEmail
        saved_sender_email = last_patch_payload.get("settings", {}).get("senderEmail")
        assert saved_sender_email == "growth@newagency.io", f"Backend payload should have 'growth@newagency.io', got {saved_sender_email}"
        print(f"  ✓ Verified: Saved payload has senderEmail = '{saved_sender_email}'.")

        # Verify Signature was also preserved
        saved_signature = last_patch_payload.get("settings", {}).get("signature")
        assert "Alex Mercer" in (saved_signature or ""), "Saved signature must be preserved."
        print("  ✓ Verified: Saved signature flowed through payload without requiring SMTP.")

        ctx_b.close()
        browser.close()

    print("\n🎉 ALL TESTS PASSED SUCCESSFULLY! Both states verified!")

if __name__ == "__main__":
    run_test()
