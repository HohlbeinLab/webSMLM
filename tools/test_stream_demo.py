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
N_CHUNKS = 300
FRAMES_PER_CHUNK = 1
W = H = 64
SIM_FRAME_INTERVAL_S = 0.03   # a stand-in for the real per-frame acquisition rate


def make_frame(cx, cy, peak=4000, bg=100, sigma=1.3):
    yy, xx = np.mgrid[0:H, 0:W]
    signal = bg + peak * np.exp(-((xx - cx) ** 2 + (yy - cy) ** 2) / (2 * sigma ** 2))
    noisy = np.random.poisson(signal).astype(np.float64)   # light shot noise, so it's not a flat blob
    return np.clip(noisy, 0, 65535).astype(np.uint16)


def make_chunk_bytes(n_frames, cx, cy):
    """Builds one chunk's worth of frames (a slow random walk of a single
    emitter) and returns (tiff_bytes, new_cx, new_cy)."""
    frames = []
    for _ in range(n_frames):
        cx = float(np.clip(cx + np.random.uniform(-0.3, 0.3), 8, W - 8))
        cy = float(np.clip(cy + np.random.uniform(-0.3, 0.3), 8, H - 8))
        frames.append(make_frame(cx, cy))
    stack = np.stack(frames, axis=0)
    buf = io.BytesIO()
    # imagej=True -> the contiguous ImageJ-style multi-frame layout webSMLM's
    # in/out module indexes arithmetically (same format the real Gladoscopy
    # RT node writes, and the fast path webSMLM's own sample data uses).
    tifffile.imwrite(buf, stack, imagej=True)
    return buf.getvalue(), cx, cy


async def stream_to(ws):
    print(f'webSMLM connected from {ws.remote_address}.')
    await asyncio.to_thread(
        input,
        '\nIn the webSMLM window: open "Live streaming" in the sidebar and click '
        '"Start streaming" if you have not already.\n'
        'Press Enter here to begin sending simulated frame chunks...\n',
    )
    cx, cy = W / 2, H / 2
    try:
        for i in range(N_CHUNKS):
            body, cx, cy = make_chunk_bytes(FRAMES_PER_CHUNK, cx, cy)
            await ws.send(body)
            print(f'sent chunk {i + 1}/{N_CHUNKS} ({len(body)} bytes)')
            await asyncio.sleep(FRAMES_PER_CHUNK * SIM_FRAME_INTERVAL_S)
    except KeyboardInterrupt:
        print('\nInterrupted -- stopping early.')
    finally:
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
