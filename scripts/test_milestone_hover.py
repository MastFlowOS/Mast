import time
from playwright.sync_api import sync_playwright

def run_hover_test():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1280, "height": 800})
        page = context.new_page()

        print("Navigating to http://localhost:5173/milestone-preview ...")
        page.goto("http://localhost:5173/milestone-preview")
        page.wait_for_selector(".focus-mountain-terrain-stage")
        time.sleep(1.0)

        # Locate the 4 pins
        # Pins have aria-label containing tier name or role="img"
        pins = [
            ("Explorer", page.locator('.focus-summit-pin-group[aria-label*="Explorer"]')),
            ("Prospector", page.locator('.focus-summit-pin-group[aria-label*="Prospector"]')),
            ("Closer", page.locator('.focus-summit-pin-group[aria-label*="Closer"]')),
            ("Rainmaker", page.locator('.focus-summit-pin-group[aria-label*="Rainmaker"]')),
        ]

        # Reset mouse away
        page.mouse.move(10, 10)
        time.sleep(0.3)

        all_passed = True

        for name, pin_loc in pins:
            print(f"\n--- Testing Checkpoint: {name} ---")
            assert pin_loc.count() == 1, f"Pin for {name} not found or not unique"
            
            # Baseline box before any hover
            base_box = pin_loc.bounding_box()
            base_cx = base_box["x"] + base_box["width"] / 2
            base_cy = base_box["y"] + base_box["height"] / 2
            print(f"  Baseline center: ({base_cx:.2f}, {base_cy:.2f}), size: {base_box['width']:.2f}x{base_box['height']:.2f}")

            # Test approaches from 4 directions
            directions = [
                ("Top", (base_cx, base_cy - 80)),
                ("Bottom", (base_cx, base_cy + 80)),
                ("Left", (base_cx - 80, base_cy)),
                ("Right", (base_cx + 80, base_cy)),
            ]

            for dir_name, start_pt in directions:
                # Move start
                page.mouse.move(start_pt[0], start_pt[1])
                time.sleep(0.05)

                # Move into pin center
                page.mouse.move(base_cx, base_cy)
                time.sleep(0.2) # wait for any transition

                # Measure during hover
                hover_box = pin_loc.bounding_box()
                hover_cx = hover_box["x"] + hover_box["width"] / 2
                hover_cy = hover_box["y"] + hover_box["height"] / 2

                dx = abs(hover_cx - base_cx)
                dy = abs(hover_cy - base_cy)

                print(f"  Approach from {dir_name}: center=({hover_cx:.2f}, {hover_cy:.2f}), dx={dx:.4f}px, dy={dy:.4f}px")

                if dx > 0.05 or dy > 0.05:
                    print(f"  [FAIL] Checkpoint {name} MOVED on hover from {dir_name}! dx={dx}, dy={dy}")
                    all_passed = False

                # Leave pin back to start_pt
                page.mouse.move(start_pt[0], start_pt[1])
                time.sleep(0.1)

                leave_box = pin_loc.bounding_box()
                leave_cx = leave_box["x"] + leave_box["width"] / 2
                leave_cy = leave_box["y"] + leave_box["height"] / 2
                dx_leave = abs(leave_cx - base_cx)
                dy_leave = abs(leave_cy - base_cy)
                if dx_leave > 0.05 or dy_leave > 0.05:
                    print(f"  [FAIL] Checkpoint {name} shifted after leaving! dx={dx_leave}, dy={dy_leave}")
                    all_passed = False

            # Capture a screenshot with mouse hovering this pin to verify glow without movement
            page.mouse.move(base_cx, base_cy)
            time.sleep(0.2)
            page.screenshot(path=f"milestone_validation_screenshots/hover_{name.lower()}.png")
            print(f"  Saved hover screenshot: milestone_validation_screenshots/hover_{name.lower()}.png")

            # Move away
            page.mouse.move(10, 10)
            time.sleep(0.1)

        print(f"\n==========================================")
        if all_passed:
            print("ALL CHECKPOINT HOVER TESTS PASSED: ZERO POSITIONAL MOVEMENT!")
        else:
            print("SOME CHECKPOINT HOVER TESTS FAILED!")
        print("==========================================")

        browser.close()
        assert all_passed, "Hover test failed due to positional movement"

if __name__ == "__main__":
    run_hover_test()
