#!/usr/bin/env python3
"""tools/test_stream_demo.py — standalone demo/test driver for webSMLM's live
streaming feature (window.webSMLM.stream, tools/webSMLM-stream.mjs), with NO
Gladoscopy/pycromanager dependency: it launches the same persistent bridge
script a real Gladoscopy RT node would talk to, but feeds it synthetic
frames (a single emitter on a slow random walk, so something visibly moves
in the reconstruction as chunks arrive) instead of real microscope frames.

Setup (once):
    cd tools && npm install          # installs Playwright + downloads Chromium
    pip install numpy tifffile

Usage:
    python tools/test_stream_demo.py
A Chromium window opens showing webSMLM.html. In the sidebar, open the
"Live streaming" section and click "Start streaming" — pxnm/gain/method/etc.
are read from whatever the page controls are set to at that moment, exactly
like an ordinary interactive Localize. Then come back to this terminal and
press Enter to start sending simulated frame chunks; watch the SMLM
reconstruction panel fill in live. Ctrl+C stops early (a final "stop" is
still sent so the session ends cleanly either way).

This exercises the exact same wire protocol — a JSON header line
({"cmd":"push","nBytes":N} or {"cmd":"stop"}) followed by N raw TIFF bytes —
that glados_pycromanager/AutonomousMicroscopy/Real_Time_Analysis/
webSMLM_stream.py (in the Gladoscopy repo) uses for real, so this script
doubles as a quick sanity check for that integration without needing a full
pycromanager/Micro-Manager setup running.
"""
import io
import json
import subprocess
import sys
import time
from pathlib import Path

import numpy as np

try:
    import tifffile
except ImportError:
    sys.exit('This demo needs tifffile: pip install numpy tifffile')

REPO_ROOT = Path(__file__).resolve().parent.parent
BRIDGE = REPO_ROOT / 'tools' / 'webSMLM-stream.mjs'

N_CHUNKS = 30
FRAMES_PER_CHUNK = 10
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
        cx = np.clip(cx + np.random.uniform(-0.3, 0.3), 8, W - 8)
        cy = np.clip(cy + np.random.uniform(-0.3, 0.3), 8, H - 8)
        frames.append(make_frame(cx, cy))
    stack = np.stack(frames, axis=0)
    buf = io.BytesIO()
    # imagej=True -> the contiguous ImageJ-style multi-frame layout webSMLM's
    # in/out module indexes arithmetically (same format the real Gladoscopy
    # RT node writes, and the fast path webSMLM's own sample data uses).
    tifffile.imwrite(buf, stack, imagej=True)
    return buf.getvalue(), cx, cy


def send(proc, header_obj, body=b''):
    proc.stdin.write((json.dumps(header_obj) + '\n').encode('utf-8'))
    if body:
        proc.stdin.write(body)
    proc.stdin.flush()


def read_reply(proc):
    line = proc.stdout.readline()
    if not line:
        raise RuntimeError('bridge process closed stdout unexpectedly (did it crash? check its own window/terminal)')
    return json.loads(line.decode('utf-8'))


def main():
    if not BRIDGE.exists():
        sys.exit(f'Bridge script not found: {BRIDGE}')

    print('Launching the webSMLM streaming bridge (a Chromium window will open)...')
    proc = subprocess.Popen(
        ['node', str(BRIDGE)], cwd=str(REPO_ROOT),
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )

    # The bridge's own human-readable status lands on stderr (stdout is
    # reserved for one JSON reply per command) -- print it live and wait for
    # "Ready" before doing anything else, same as a real RT node would.
    ready = False
    while not ready:
        line = proc.stderr.readline()
        if not line:
            sys.exit('Bridge exited before becoming ready -- check Node.js is installed and '
                      '`cd tools && npm install` has been run.')
        text = line.decode('utf-8', 'replace').rstrip()
        print('[bridge]', text)
        ready = 'Ready' in text

    input('\nIn the webSMLM window: open the "Live streaming" section in the sidebar '
          '(it\'s collapsed by default) and click "Start streaming".\n'
          'Then come back here and press Enter to begin sending simulated frame chunks...\n')

    cx, cy = W / 2, H / 2
    try:
        for i in range(N_CHUNKS):
            body, cx, cy = make_chunk_bytes(FRAMES_PER_CHUNK, cx, cy)
            send(proc, {'cmd': 'push', 'nBytes': len(body)}, body)
            reply = read_reply(proc)
            print(f'chunk {i + 1}/{N_CHUNKS}:', reply)
            if not reply.get('ok'):
                print('  (was "Start streaming" clicked in the webSMLM window yet?)')
            time.sleep(FRAMES_PER_CHUNK * SIM_FRAME_INTERVAL_S)
    except KeyboardInterrupt:
        print('\nInterrupted -- stopping early.')
    finally:
        send(proc, {'cmd': 'stop'})
        try:
            print('stop reply:', read_reply(proc))
        except Exception:
            pass
        proc.wait(timeout=30)
        print('Done -- the reconstruction stays on screen in the webSMLM window.')


if __name__ == '__main__':
    main()
