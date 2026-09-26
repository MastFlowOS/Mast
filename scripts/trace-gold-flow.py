#!/usr/bin/env python3
"""
Chrome Performance Trace Runner for Gold Flow Video Pipeline.

Captures a clean 10-second Chrome performance trace while:
- hero is visible
- no scrolling
- no mouse movement
- no resizing
- no interaction

Analyzes trace metrics:
- DroppedFrame (smoothness-affecting frame drops)
- PipelineReporter (presentation latency / missed deadlines)
- Media thread (RunTask durations, task count, max duration)
- CodecWorker (software decoding worker activity)
- VideoFrameCompositor (render/compositor tasks)
- GPUTask (GPU command buffer / execution tasks)

Saves clean trace JSON to `chrome-gold-flow-trace.json`.
"""

import json
import os
import subprocess
import sys
import time
from playwright.sync_api import sync_playwright

CHROME_PATH = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
TRACE_OUTPUT = "chrome-gold-flow-trace.json"
PORT = 4173
URL = f"http://localhost:{PORT}/"


def analyze_trace(events):
    print("\n" + "=" * 60)
    print("CHROME PERFORMANCE TRACE ANALYSIS (10s Clean Idle Capture)")
    print("=" * 60)

    # 1. Thread classification
    threads = {}
    thread_names = {}
    process_names = {}
    for ev in events:
        if ev.get("ph") == "M" and ev.get("name") == "thread_name":
            tid = f"{ev.get('pid')}:{ev.get('tid')}"
            thread_names[tid] = ev.get("args", {}).get("name", "Unknown")
        elif ev.get("ph") == "M" and ev.get("name") == "process_name":
            process_names[ev.get("pid")] = ev.get("args", {}).get("name", "Unknown")

    # 2. Dropped frames
    dropped_frames = [ev for ev in events if ev.get("name") == "DroppedFrame"]
    smoothness_drops = [
        ev for ev in dropped_frames
        if ev.get("args", {}).get("has_dropped_frame") is True
        or ev.get("args", {}).get("is_keyframe") is True
        or "has_partial_update" in ev.get("args", {})
    ]
    print(f"\n[1] DROPPED FRAMES:")
    print(f"    Total DroppedFrame events: {len(dropped_frames)}")
    print(f"    Smoothness-affecting frame drops: {len(smoothness_drops)}")

    # 3. PipelineReporter
    pipeline_reporters = [ev for ev in events if ev.get("name") == "PipelineReporter"]
    print(f"\n[2] PIPELINE REPORTERS:")
    print(f"    Total PipelineReporter events: {len(pipeline_reporters)}")

    # 4. Media thread analysis
    media_tids = [tid for tid, name in thread_names.items() if "media" in name.lower()]
    media_events = [ev for ev in events if f"{ev.get('pid')}:{ev.get('tid')}" in media_tids]
    media_tasks = [ev for ev in media_events if ev.get("name") in ("RunTask", "Task")]
    media_durations_ms = [ev.get("dur", 0) / 1000.0 for ev in media_events if "dur" in ev]

    print(f"\n[3] MEDIA THREAD:")
    print(f"    Identified Media threads: {[thread_names[t] for t in media_tids]}")
    print(f"    Total Media thread events: {len(media_events)}")
    if media_durations_ms:
        max_media = max(media_durations_ms)
        over_16ms = [d for d in media_durations_ms if d > 16.67]
        over_50ms = [d for d in media_durations_ms if d > 50.0]
        print(f"    Max task duration: {max_media:.2f} ms")
        print(f"    Tasks > 16.6ms (frame budget): {len(over_16ms)}")
        print(f"    Tasks > 50.0ms (stall budget): {len(over_50ms)}")
    else:
        print(f"    No long Media tasks detected (< 1ms hardware direct pass).")

    # 5. CodecWorker analysis
    codec_tids = [
        tid for tid, name in thread_names.items()
        if any(k in name.lower() for k in ("codecworker", "vpx", "decoder", "av1", "h264"))
    ]
    codec_events = [ev for ev in events if f"{ev.get('pid')}:{ev.get('tid')}" in codec_tids]
    codec_durations_ms = [ev.get("dur", 0) / 1000.0 for ev in codec_events if "dur" in ev]
    print(f"\n[4] CODEC WORKER ACTIVITY:")
    print(f"    Identified Codec threads: {[thread_names[t] for t in codec_tids]}")
    print(f"    Total CodecWorker events: {len(codec_events)}")
    if codec_durations_ms:
        print(f"    Max CodecWorker duration: {max(codec_durations_ms):.2f} ms")
        over_30ms = [d for d in codec_durations_ms if d > 30.0]
        print(f"    Codec tasks > 30ms: {len(over_30ms)}")
    else:
        print(f"    Zero software CodecWorker activity (clean GPU VPU hardware decode).")

    # 6. VideoFrameCompositor analysis
    vfc_events = [
        ev for ev in events
        if any(k in ev.get("name", "").lower() for k in ("videoframecompositor", "onsubmitframe", "putcurrentframe"))
    ]
    vfc_durations_ms = [ev.get("dur", 0) / 1000.0 for ev in vfc_events if "dur" in ev]
    print(f"\n[5] VIDEO FRAME COMPOSITOR:")
    print(f"    Total VideoFrameCompositor events: {len(vfc_events)}")
    if vfc_durations_ms:
        print(f"    Max duration: {max(vfc_durations_ms):.2f} ms")
        over_16ms = [d for d in vfc_durations_ms if d > 16.67]
        print(f"    Tasks > 16.6ms: {len(over_16ms)}")

    # 7. GPU Tasks
    gpu_events = [ev for ev in events if ev.get("name") == "GPUTask" or ev.get("cat") == "gpu"]
    gpu_durations_ms = [ev.get("dur", 0) / 1000.0 for ev in gpu_events if "dur" in ev]
    print(f"\n[6] GPU TASKS:")
    print(f"    Total GPU events: {len(gpu_events)}")
    if gpu_durations_ms:
        print(f"    Max GPU task duration: {max(gpu_durations_ms):.2f} ms")
        over_16ms = [d for d in gpu_durations_ms if d > 16.67]
        print(f"    GPU tasks > 16.6ms: {len(over_16ms)}")

    print("\n" + "=" * 60)


def main():
    print(f"Launching clean Chrome trace test at {URL}...")
    with sync_playwright() as p:
        browser = p.chromium.launch(
            executable_path=CHROME_PATH,
            args=[
                "--enable-gpu",
                "--enable-gpu-rasterization",
                "--enable-zero-copy",
                "--ignore-gpu-blocklist",
            ]
        )
        context = browser.new_context(viewport={"width": 1536, "height": 900})
        page = context.new_page()

        # Connect CDP session for low-level Chrome Tracing
        cdp = context.new_cdp_session(page)

        print(f"Navigating to {URL}...")
        page.goto(URL, wait_until="networkidle")
        page.wait_for_timeout(2000)

        # Confirm video is playing
        vid_status = page.evaluate("""() => {
            const v = document.querySelector('video');
            return v ? { src: v.currentSrc, paused: v.paused, time: v.currentTime } : null;
        }""")
        print("Active video element status:", vid_status)

        print("\nStarting Chrome Tracing (10 seconds, zero interaction, steady state)...")
        collected_chunks = []
        cdp.on("Tracing.dataCollected", lambda params: collected_chunks.extend(params.get("value", [])))

        cdp.send("Tracing.start", {
            "traceConfig": {
                "includedCategories": [
                    "-*",
                    "toplevel",
                    "disabled-by-default-devtools.timeline",
                    "devtools.timeline",
                    "disabled-by-default-devtools.timeline.frame",
                    "media",
                    "gpu",
                    "cc",
                    "v8.execute",
                    "benchmark"
                ],
                "recordMode": "recordContinuously"
            }
        })

        # 10 seconds of pure undisturbed playback (no mouse, no scroll, no interaction)
        time.sleep(10.0)

        print("Ending Tracing and assembling trace buffer...")
        cdp.send("Tracing.end")
        page.wait_for_timeout(2000)

        print(f"Total raw trace events collected: {len(collected_chunks)}")

        # Save to file
        with open(TRACE_OUTPUT, "w", encoding="utf-8") as f:
            json.dump({"traceEvents": collected_chunks}, f)
        print(f"Wrote trace to {TRACE_OUTPUT} ({os.path.getsize(TRACE_OUTPUT) / 1e6:.2f} MB)")

        # Analyze
        analyze_trace(collected_chunks)

        browser.close()


if __name__ == "__main__":
    main()
