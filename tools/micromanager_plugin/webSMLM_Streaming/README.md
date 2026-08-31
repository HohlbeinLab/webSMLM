# webSMLM_Streaming — Micro-Manager plugin

A Micro-Manager 2.0 Java plugin that streams live camera frames (Snap, Live, MDA, or Album —
whatever Micro-Manager is currently acquiring) to a [webSMLM](../../webSMLM.html) browser tab over
WebSocket, so localizations render in real time as frames come off the camera. It's the "real
acquisition source" counterpart to [`tools/test_livestream_demo.py`](../../tools/test_livestream_demo.py),
which is a synthetic Python stand-in for testing the same wire protocol without a microscope.

**Status**: builds cleanly against a real MM 2.0.3 install (`mvn package`, verified below) and its
TIFF chunk format has been independently verified byte-correct via `tifffile`. User-tested against
a live MM session: **Live, Snap, and MDA all confirmed working** (Snap/MDA were initially broken,
then fixed — see *Corrections* below). **Album was confirmed broken** on that same test round and
has now been fixed too (see *Corrections* below) — re-test Album specifically in a live session is
the next step, see *Known limitations*.

## What it does

1. Adds a **webSMLM Streaming** entry to Micro-Manager's *Plugins* menu.
2. Opens a small settings window: **Host** (default `localhost`), **Port** (default `8765`),
   **Frames per chunk** (default `1`), and a **Start/Stop** button. Settings persist across MM
   restarts via MM's own per-user profile.
3. On **Start**, it opens a WebSocket server on `host:port` and starts watching for new frames:
   every currently-open display window's datastore, polled and refreshed twice a second, which
   covers Live, Snap, and MDA alike (see *Corrections* below for why this is polled rather than
   event-driven), **plus** the Album feature's own datastore, polled the same way but separately
   (Album doesn't go through a display window's own DataProvider the way Live/Snap/MDA do — see
   *Corrections* below). Frames are batched into groups of *Frames per chunk*; each full batch is
   encoded as an ImageJ-style TIFF and broadcast as one WebSocket binary message to any connected
   client.
4. In webSMLM, open the **Live streaming** panel, set the WebSocket URL to `ws://<host>:<port>`
   (e.g. the default `ws://localhost:8765`), and click **Connect** — chunks start rendering as
   soon as MM produces frames.
5. **Stop** sends `{"cmd":"stop"}` to every connected client (ending their session without
   dropping the connection) and shuts the server down.

## Wire protocol

Identical to what `tools/test_livestream_demo.py` implements and `webSMLM.html`'s
`liveStreamWsConnect()`/`liveStreamPushChunkFile()` consume:

- The plugin is always the WebSocket **server**; webSMLM's browser tab is always the **client**.
- One chunk of frames = one WebSocket **binary** message, whose payload is the raw bytes of an
  ImageJ-style TIFF (produced here via `ij.io.FileSaver#saveAsTiff`, matching
  `tifffile.imwrite(..., imagej=True)` on the Python side — both a 1-frame and an N-frame chunk
  carry the same `ImageJ=1.xx` description tag `loadTiffFile()`'s fast path looks for). No length
  prefix, no wrapper — the WebSocket message boundary *is* the chunk boundary.
- No width/height/dtype/frame-count metadata is sent separately — the client decodes all of that
  from the TIFF bytes themselves.
- Ending a session without closing the socket: one WebSocket **text** message,
  `{"cmd":"stop"}`.
- No other message types; no ack/backpressure.

Currently only 8-bit and 16-bit grayscale cameras are supported (`Image.getBytesPerPixel()` of 1
or 2) — RGB/32-bit frames are rejected with a logged error rather than silently mis-encoded.

## Building

Requires a local Micro-Manager 2.0 installation (for `MMJ_.jar`, `MMCoreJ.jar`, `ij.jar`, and
`scijava-common-*.jar`, none of which are published to Maven Central), a JDK (11+; built and
tested with Temurin 17), and Maven 3.6+.

```sh
mvn package -Dmm.install.dir="C:\path\to\your\Micro-Manager-install"
```

(`mm.install.dir` in `pom.xml` currently defaults to the install this was built and tested
against: `C:\Users\koen-\AppData\Local\pymmcore-plus\pymmcore-plus\mm\Micro-Manager_2.0.3_20260225`
— override it for any other machine.) This produces a shaded jar at `target/webSMLM_Streaming.jar`
containing the plugin classes plus the bundled `Java-WebSocket` library; the Micro-Manager/ImageJ/
Guava/slf4j-api jars themselves stay `system`/`provided`-scoped and are **not** bundled, since
they're already supplied by whichever MM instance loads the plugin.

Verified: `mvn clean package` succeeds end-to-end against a real MM 2.0.3 install (`BUILD
SUCCESS`, jar contains all 4 plugin classes at their expected `org/kjamartens/websmlm/streaming/`
paths).

## Installing

Copy `target/webSMLM_Streaming.jar` into your Micro-Manager installation's `mmplugins/` folder
(create it next to `plugins/` if it doesn't already exist) and restart Micro-Manager. The plugin
should then appear under *Plugins → webSMLM Streaming*.

## What was verified, and how

Every non-trivial Micro-Manager/ImageJ API call this plugin makes was checked with `javap`
against the real jars from a working MM 2.0.3 install before/after writing the code (not guessed
blind) — `org.micromanager.MenuPlugin`/`MMPlugin`, `Studio`, `UserProfile` +
`propertymap.MutablePropertyMapView` (the actual settings-persistence API — see *Corrections*
below), `Application#getMainWindow()`, `data.Image`, `data.DataProvider`/`Datastore`,
`data.DataProviderHasNewImageEvent`, `acquisition.AcquisitionStartedEvent`/`AcquisitionEndedEvent`,
`events.LiveModeEvent`, and `org.scijava.plugin.Plugin`/`SciJavaPlugin`. The whole plugin compiles
and packages cleanly against them (`mvn clean package`).

The TIFF-chunk encoding path was further checked independently of Micro-Manager entirely: a
standalone Java program built the same `ImageStack`→`ImagePlus`→`FileSaver` pipeline
`StreamingController.encodeAsImageJTiffStack` uses, for both a 1-frame and a 3-frame batch, and
the resulting bytes were decoded with Python's `tifffile` (the same library
`tools/test_livestream_demo.py` uses) — `is_imagej: True`, byte-exact pixel data, and correct
`(frames, height, width)` shape/dtype in both cases.

### Corrections made during verification (things that were wrong on the first pass)

- **Settings persistence**: `UserProfile.getSettings(Class)` returns a live, directly-mutable
  `org.micromanager.propertymap.MutablePropertyMapView` (`getString`/`putString`/`getInteger`/
  `putInteger`, writes take effect immediately) — there is no `PropertyMap settings; ...;
  profile.setSettings(cls, settings)` round trip as originally written; `StreamingConfigDialog`
  now reads/writes the mutable view directly.
- **Frame-arrival events**: Micro-Manager 2.0 has no single global "new image" event. Each
  `DataProvider` (a Live/Snap display's datastore, or an MDA run's `Datastore`) posts
  `DataProviderHasNewImageEvent` on **its own** event bus (`DataProvider#registerForEvents`), not
  on `Studio.events()`. The first version of `StreamingController` tried to track this via the
  global events that *announce* a new DataProvider (`LiveModeEvent`,
  `AcquisitionStartedEvent`/`AcquisitionEndedEvent`, both confirmed via bytecode inspection to be
  posted on `Studio.events()` by MM's real acquisition engine) — **user-tested and confirmed
  broken for Snap and MDA**. Root cause for Snap: MM lazily creates the Live/Snap display's
  datastore on the *first* Snap or Live-on of a session; `LiveModeEvent` only fires for a Live
  toggle, never for a plain Snap, so a plugin that was started before the user's first Snap never
  got a chance to register on it. MDA's root cause wasn't fully isolated (the events *are* posted
  correctly per bytecode), but rather than keep chasing individual event edge cases,
  `StreamingController` now uses one simpler, uniformly correct mechanism instead: poll
  `Studio.displays().getAllDataViewers()` every 500 ms (plus once synchronously on Start), and
  register/unregister on each viewer's `DataProvider` as the list changes. This list is backed by
  `DisplayManager#createDisplay`'s own `addViewer()` call (confirmed via bytecode) — every one of
  Live/Snap's and an MDA run's own display-creation paths goes through `createDisplay()`, so this
  one mechanism covers all three without needing to special-case any of them.
- **TIFF encoding**: `ij.io.FileSaver#saveAsTiffStack` refuses a single-slice `ImageStack`
  ("This is not a stack", returns `false`) — which is the *default* case here, since "Frames per
  chunk" defaults to `1`. Switched to the generic `FileSaver#saveAsTiff`, confirmed (via the
  `tifffile` check above) to write a correctly ImageJ-tagged TIFF for both a 1-slice and an
  N-slice stack.
- **Album**: after Live/Snap/MDA were all confirmed working in a live session, Album was
  user-confirmed **not** streaming. Root cause, confirmed via `javap` against the real MM 2.0.3
  jars: `Studio.album()` returns an `org.micromanager.Album`, backed by its own
  `org.micromanager.data.Datastore` — a completely separate object from anything
  `Studio.displays().getAllDataViewers()` surfaces, regardless of whether an Album window happens
  to be open. `pollDataProviders()` only ever walked the display-viewer list, so Album's datastore
  was never registered on at all. Fixed by polling `studio.album().getDatastore()` as a second,
  independent step every tick (`Datastore extends DataProvider`, so it registers on it exactly the
  same way as any display's own provider — no separate event-handling path needed).

## Known limitations

- **Album fix not yet re-verified in a live session.** Live, Snap, and MDA are all user-confirmed
  working. Album was user-confirmed broken (see *Corrections* above) and has been fixed by
  additionally polling `studio.album().getDatastore()`, verified so far only by a `javap`-confirmed
  API shape and a clean `mvn`/manual javac rebuild — not yet re-tested by actually clicking Album
  in a live MM session. Do that next: build, drop the jar into `mmplugins/`, launch MM, open
  *Plugins → webSMLM Streaming*, click Start, then press Album a few times, confirming chunks
  arrive and render in webSMLM's **Live streaming** panel.
- The display-polling mechanism (Live/Snap/MDA, not Album — Album's datastore is polled directly
  regardless of whether it has a window open, see *Corrections* above) only sees a datastore once
  MM has shown a display window for it, which is the default for Snap/Live/MDA but can be turned
  off (e.g. an MDA run with "Show" unchecked, or an entirely scripted/headless acquisition) — such
  a datastore currently won't be picked up. Not expected to matter for normal interactive use;
  worth knowing if a future report says "still not streaming" for a specifically headless
  acquisition.
- New frames can take up to ~500 ms (the poll interval) to start streaming after a *brand new*
  display window is created (the very first Snap or Live-on of a session, or the first frame of a
  fresh MDA run) — after that, the same display's `DataProvider` is already registered and every
  subsequent frame streams immediately. Lower `POLL_INTERVAL_MS` in `StreamingController` if this
  lag turns out to matter in practice.
- Only 8-bit and 16-bit grayscale cameras are supported (see *Wire protocol* above).
- Each chunk is round-tripped through a short-lived temp file (`FileSaver` writes to a path, not
  a stream) rather than encoded fully in memory — simple and known-correct, but adds one small
  local-disk write+read per chunk; revisit if chunk-rate profiling ever shows this as a
  bottleneck.
