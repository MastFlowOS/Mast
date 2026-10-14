"""Deterministic probe of the REAL utils.runtime.RateLimiter under a fake clock.
No real sleeping; jitter disabled so the result is exact, not noisy."""
import asyncio, sys, types
sys.path.insert(0, ".")
import utils.runtime as rt

class FakeClock:
    def __init__(self): self.t = 0.0
clock = FakeClock()
rt.time = types.SimpleNamespace(monotonic=lambda: clock.t, time=lambda: clock.t, perf_counter=lambda: clock.t)
async def fake_sleep(d): clock.t += d
rt.asyncio = types.SimpleNamespace(Lock=asyncio.Lock, sleep=fake_sleep)

async def measure(rpm, burst, n, min_delay_ms):
    clock.t = 0.0
    lim = rt.RateLimiter(requests_per_minute=rpm, burst=burst, jitter_pct=0, min_delay_ms=min_delay_ms)
    stamps = []
    for _ in range(n):
        await lim.acquire("probe")
        stamps.append(clock.t)
    return stamps

async def main():
    for name, rpm, burst, md in [("maps_place (20rpm, burst3, 800ms)", 20, 3, 800),
                                 ("site (30rpm, burst5, 400ms)", 30, 5, 400)]:
        n = 41
        s = await measure(rpm, burst, n, md)
        gaps = [round(b - a, 2) for a, b in zip(s, s[1:])]
        span = s[-1] - s[burst - 1]            # time to do the post-burst requests
        post = n - burst
        eff = post / span * 60 if span else float("inf")
        print(f"\n{name}")
        print("  inter-request gaps (s):", gaps[:14], "...")
        print(f"  declared sustained rate : {rpm} rpm")
        print(f"  EFFECTIVE sustained rate: {eff:.1f} rpm  (post-burst {post} reqs in {span:.1f}s)")
asyncio.run(main())
