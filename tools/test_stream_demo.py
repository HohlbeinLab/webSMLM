#!/usr/bin/env python3
"""tools/test_stream_demo.py — standalone WebSocket demo/test driver for
webSMLM's live streaming feature (window.webSMLM.stream), with NO browser
automation at all: this runs a tiny local WebSocket SERVER that YOUR OWN,
already-open webSMLM.html tab (any browser — Firefox included) connects OUT
to, opt-in, only when you click "Connect" in its "Live streaming" sidebar
section. Nothing here launches, controls, or even needs to know about a
browser process.

Setup (once):
    pip install numpy tifffile websockets

Usage:
    python tools/test_stream_demo.py
    # Open webSMLM.html yourself, in whatever browser tab you already have.
    # In the sidebar: open "Live streaming" (collapsed by default), set the
    # WebSocket URL to ws://localhost:8765 (this script's default), click
    # "Connect", then click "Start streaming". Come back here and press
    # Enter to start sending simulated frame chunks; watch the SMLM
    # reconstruction panel fill in live.

Wire format: each chunk is sent as one WebSocket BINARY message (raw TIFF
bytes) — no extra framing needed, since WebSocket already frames messages
for us. A final `{"cmd":"stop"}` TEXT message finalizes the streaming
session on the page (same as clicking "Stop streaming" there) WITHOUT
closing the connection or your tab.

This is a different bridge from tools/webSMLM-stream.mjs, which launches
and owns its own Playwright-driven Chromium window instead — the right
choice for a fully automated/headless session (e.g. a real Gladoscopy RT
node), but the wrong one when you just want to hook into a tab you already
have open.
"""
import asyncio
import io
import json
import sys
import time

import numpy as np

try:
    import tifffile
except ImportError:
    sys.exit('This demo needs tifffile: pip install numpy tifffile')

try:
    import websockets
except ImportError:
    sys.exit('This demo needs websockets: pip install websockets')

HOST = 'localhost'
PORT = 8765
N_CHUNKS = 500
FRAMES_PER_CHUNK = 1
LOCS_PER_FRAME = 10   # simulated emitters per frame -- raise this to stress-test detection/fit density
W = H = 256
SIM_FRAME_INTERVAL_S = 0.03   # a stand-in for the real per-frame acquisition rate


# PSF_HALF: half-width (px) of the LOCAL window each emitter's Gaussian is
# actually evaluated over. make_frame() used to evaluate exp() (and a fresh
# np.random.poisson() draw) across the FULL W*H frame for every single
# emitter -- fine at the original 64x64/1-emitter test size, but a real,
# reported slowdown once pushed toward stress-test settings (e.g. 1000x1000,
# 10 emitters, 50 frames/chunk: measured at ~48s to pre-render just 10
# chunks). A Gaussian's tail beyond a few sigma is negligible -- PSF_HALF=6
# is >4x PSF_SIGMA=1.3, so the discarded tail is astronomically small -- so
# only a small (2*PSF_HALF+1)^2 patch around each emitter's own (sub-pixel)
# position is touched at all, turning per-emitter cost from O(W*H) into
# O(PSF_HALF^2), independent of frame size.
#
# BG_NOISE_POOL_SIZE precomputed background-noise realizations (see
# _get_noise_pool() below), cycled per frame instead of drawing a fresh
# np.random.poisson() over the WHOLE frame every single frame -- profiling
# showed this (not TIFF encoding, which turned out fast already) was the
# actual dominant remaining cost once the per-emitter loop above was already
# localized: real per-frame-independent background noise isn't needed for a
# synthetic stress test, only *some* believable noise floor is, so a small
# reused pool trades that for a large, measured speedup (~9.5x on the frame-
# generation step alone) at large W*H. Actual emitter signal still gets a
# FRESH, local Poisson draw each frame (only over each emitter's own small
# patch, so it stays cheap) -- only the plain background noise repeats.
PSF_SIGMA = 1.3
PSF_HALF = 6
BG_NOISE_POOL_SIZE = 8
_bg_noise_pool = None


def _get_bg_noise_pool(bg):
    global _bg_noise_pool
    if _bg_noise_pool is None:
        base = np.full((H, W), bg, dtype=np.float64)
        _bg_noise_pool = [np.random.poisson(base).astype(np.float64) for _ in range(BG_NOISE_POOL_SIZE)]
    return _bg_noise_pool


def make_frame(emitters, peak=4000, bg=100, sigma=PSF_SIGMA):
    """emitters: list of (cx,cy) -- one Gaussian blob per emitter, each with
    its own fresh local Poisson draw, composited (sub-pixel accurate) onto a
    recycled pre-noised background."""
    pool = _get_bg_noise_pool(bg)
    signal = pool[np.random.randint(len(pool))].copy()
    r = PSF_HALF
    for cx, cy in emitters:
        x0, x1 = max(0, int(cx) - r), min(W, int(cx) + r + 1)
        y0, y1 = max(0, int(cy) - r), min(H, int(cy) + r + 1)
        xs = np.arange(x0, x1) - cx   # sub-pixel offsets from the TRUE (fractional) emitter position
        ys = np.arange(y0, y1) - cy
        patch_mean = bg + peak * np.exp(-(xs[None, :] ** 2 + ys[:, None] ** 2) / (2 * sigma ** 2))
        signal[y0:y1, x0:x1] = np.random.poisson(patch_mean)   # fresh shot noise right at the emitter, still cheap (small patch)
    return np.clip(signal, 0, 65535).astype(np.uint16)


def init_emitters(n=LOCS_PER_FRAME):
    """n emitters at random positions, clear of the frame edge."""
    return [(float(np.random.uniform(8, W - 8)), float(np.random.uniform(8, H - 8))) for _ in range(n)]


def step_emitters(emitters):
    """One frame's worth of independent random-walk motion, each emitter
    clamped to stay clear of the frame edge (same bound make_frame's own PSF
    tails need)."""
    return [
        (float(np.clip(cx + np.random.uniform(-0.3, 0.3), 8, W - 8)),
         float(np.clip(cy + np.random.uniform(-0.3, 0.3), 8, H - 8)))
        for cx, cy in emitters
    ]


def make_chunk_bytes(n_frames, emitters):
    """Builds one chunk's worth of frames (LOCS_PER_FRAME emitters, each on
    its own slow random walk) and returns (tiff_bytes, updated_emitters)."""
    frames = []
    for _ in range(n_frames):
        emitters = step_emitters(emitters)
        frames.append(make_frame(emitters))
    stack = np.stack(frames, axis=0)
    buf = io.BytesIO()
    # imagej=True -> the contiguous ImageJ-style multi-frame layout webSMLM's
    # in/out module indexes arithmetically (same format the real Gladoscopy
    # RT node writes, and the fast path webSMLM's own sample data uses).
    tifffile.imwrite(buf, stack, imagej=True)
    return buf.getvalue(), emitters


async def stream_to(ws):
    print(f'webSMLM connected from {ws.remote_address}.')
    # Pre-render every chunk BEFORE the timed send loop starts, rather than
    # generating each one right before its own ws.send() -- np.random.poisson
    # over a W*H frame (times LOCS_PER_FRAME emitters) plus TIFF encoding is
    # real CPU work, and doing it inline between sends was stealing time from
    # the sleep, so the actual gap between sends drifted longer than
    # SIM_FRAME_INTERVAL_S once W/H or LOCS_PER_FRAME got large. Pre-rendering
    # trades memory (every chunk's bytes held at once -- roughly
    # N_CHUNKS * FRAMES_PER_CHUNK * W * H * 2 bytes before TIFF overhead) for
    # timing that's actually only the sleep, matching a real camera's fixed
    # frame rate far more closely.
    emitters = init_emitters()
    chunks = []
    print(f'Pre-rendering {N_CHUNKS} chunks ({FRAMES_PER_CHUNK} frames each, {LOCS_PER_FRAME} emitters/frame)...')
    for _ in range(N_CHUNKS):
        body, emitters = make_chunk_bytes(FRAMES_PER_CHUNK, emitters)
        chunks.append(body)
    print(f'Pre-rendered {len(chunks)} chunks, {sum(len(c) for c in chunks) / 1e6:.1f} MB total.')
    await asyncio.to_thread(
        input,
        '\nIn the webSMLM window: open "Live streaming" in the sidebar and click '
        '"Start streaming" if you have not already.\n'
        'Press Enter here to begin sending simulated frame chunks...\n',
    )
    # Track the REAL wall-clock gap between sends (not just the sleep we ask
    # for) so drift from send/await overhead -- WebSocket send latency,
    # asyncio scheduling jitter, etc. -- is visible rather than assumed away.
    # want_s is the target gap implied by SIM_FRAME_INTERVAL_S; actual_s is
    # measured via time.monotonic() around the send+sleep pair.
    want_s = FRAMES_PER_CHUNK * SIM_FRAME_INTERVAL_S
    last_send_t = None
    drifts = []
    try:
        for i, body in enumerate(chunks):
            t0 = time.monotonic()
            await ws.send(body)
            if last_send_t is not None:
                actual_s = t0 - last_send_t
                drift_s = actual_s - want_s
                drifts.append(drift_s)
                print(f'sent chunk {i + 1}/{N_CHUNKS} ({len(body)} bytes) '
                      f'-- gap {actual_s * 1000:.1f}ms (want {want_s * 1000:.1f}ms, '
                      f'drift {drift_s * 1000:+.1f}ms)')
            else:
                print(f'sent chunk {i + 1}/{N_CHUNKS} ({len(body)} bytes)')
            last_send_t = t0
            await asyncio.sleep(want_s)
    except KeyboardInterrupt:
        print('\nInterrupted -- stopping early.')
    finally:
        if drifts:
            mean_drift = sum(drifts) / len(drifts)
            max_drift = max(drifts)
            print(f'\nTiming summary: {len(drifts)} gaps measured, target {want_s * 1000:.1f}ms/chunk -- '
                  f'mean drift {mean_drift * 1000:+.1f}ms, max drift {max_drift * 1000:+.1f}ms.')
        await ws.send(json.dumps({'cmd': 'stop'}))
        print('Sent stop -- the reconstruction stays on screen in the webSMLM tab.')


async def main():
    print(f'Listening on ws://{HOST}:{PORT} -- waiting for webSMLM to connect...')
    print('In the webSMLM window: open "Live streaming" in the sidebar, set the '
          f'WebSocket URL to ws://{HOST}:{PORT} (the default), and click "Connect".')
    done = asyncio.Event()

    async def handler(ws):
        try:
            await stream_to(ws)
        finally:
            done.set()

    async with websockets.serve(handler, HOST, PORT):
        await done.wait()


if __name__ == '__main__':
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
