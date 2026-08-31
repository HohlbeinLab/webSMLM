package org.kjamartens.websmlm.streaming;

import com.google.common.eventbus.Subscribe;
import org.micromanager.Studio;
import org.micromanager.data.DataProvider;
import org.micromanager.data.DataProviderHasNewImageEvent;
import org.micromanager.data.Datastore;
import org.micromanager.data.Image;
import org.micromanager.display.DataViewer;

import javax.swing.Timer;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.CopyOnWriteArraySet;
import java.util.function.Consumer;

/**
 * Owns the lifecycle of one streaming session: watches Micro-Manager for newly acquired
 * frames, batches raw frames into chunks of {@code batchSize}, hands each chunk to {@link
 * ImageJTiffChunkEncoder} to encode as an ImageJ-style multi-page TIFF, and hands the encoded
 * bytes to a StreamingWebSocketServer to broadcast. Ack/loss bookkeeping (comparing what was
 * sent against what webSMLM confirms receiving) is delegated to {@link StreamingAckTracker} -
 * this class stays focused on MM event polling, session lifecycle, and batching, calling out
 * to those two stateless collaborators rather than doing everything itself.
 *
 * Micro-Manager 2.0 has no single global "a new image arrived" event - each
 * {@link DataProvider} (a Live/Snap display's datastore, or an MDA run's Datastore) fires
 * {@link DataProviderHasNewImageEvent} on ITS OWN event bus (DataProvider#registerForEvents),
 * not on Studio.events(). An earlier version of this class tried to track this via the
 * specific global events that announce a new DataProvider (LiveModeEvent,
 * AcquisitionStartedEvent/AcquisitionEndedEvent) - that covered Live but missed Snap (Snap does
 * not fire any global event; MM lazily creates the Live/Snap display's datastore on the FIRST
 * Snap or Live-on of a session, so a plugin started beforehand never got a chance to register)
 * and was unreliable for MDA. Replaced with a simpler, uniformly correct mechanism: poll
 * {@code Studio.displays().getAllDataViewers()} - every currently open display window
 * (confirmed, via bytecode inspection of DefaultDisplayManager#createDisplay, to be exactly the
 * list that createDisplay()'s own addViewer() call populates - every one of Live/Snap's and an
 * MDA run's own display-creation code paths goes through createDisplay()) - and register on
 * each one's DataProvider, covering Live, Snap, and MDA alike, since MM shows a display window
 * for all three by default.
 */
public class StreamingController {

    private static final int POLL_INTERVAL_MS = 500;
    // How long stop() waits for connected webSMLM clients to send back their
    // {"cmd":"ack"/"stopAck",...} confirmations (see StreamingWebSocketServer's own
    // Javadoc) before actually tearing the socket server down - long enough for a
    // client that's mid-chunk (a detect/fit pass, or a full-quality re-render) to
    // finish and reply, short enough not to make Stop feel unresponsive.
    private static final int STOP_ACK_GRACE_MS = 2000;

    private final Studio studio;
    private final Consumer<String> logger;

    private StreamingWebSocketServer server;
    private final List<Image> pendingBatch = new ArrayList<>();
    private final Set<DataProvider> registeredProviders = new CopyOnWriteArraySet<>();
    private Timer pollTimer;
    private Timer stopGraceTimer;
    private int batchSize = 1;
    private boolean running = false;
    private Consumer<String> onProgress;
    // Total frames actually handed to a successful sendChunk() this session - compared
    // against each connected client's own confirmed count once stop()'s grace period
    // elapses, to warn on frame loss. An encode/send failure inside sendBatch() is
    // already logged there immediately and deliberately does NOT count here, so this
    // comparison stays focused on loss that wasn't already explained.
    private int framesSent = 0;

    public StreamingController(Studio studio, Consumer<String> logger) {
        this.studio = studio;
        this.logger = logger;
    }

    public synchronized boolean isRunning() {
        return running;
    }

    public synchronized int getClientCount() {
        return server == null ? 0 : server.getClientCount();
    }

    public synchronized void start(String host, int port, int batchSize, Consumer<Integer> onClientCountChanged,
                                    Consumer<String> onProgress) throws IOException {
        if (running) {
            throw new IllegalStateException("Streaming server is already running.");
        }
        if (server != null) {
            // A previous session's stop() is still in its grace period (see stop()) -
            // the old server hasn't released the port yet. Refuse with a clear message
            // instead of racing it into an opaque "address already in use" bind failure.
            throw new IllegalStateException("Streaming server is still shutting down from the previous session - try again in a moment.");
        }
        this.batchSize = Math.max(1, batchSize);
        this.onProgress = onProgress;
        pendingBatch.clear();
        framesSent = 0;

        InetSocketAddress addr = new InetSocketAddress(host, port);
        server = new StreamingWebSocketServer(addr, logger, onClientCountChanged);
        server.start();

        running = true;
        pollDataProviders(); // pick up whatever's already open immediately, don't wait for the first tick
        // Reuses the same 500ms cadence for a running "frames sent vs. confirmed" readout
        // (reportFrameProgress(), below) - acks themselves arrive continuously on the
        // WebSocket thread (StreamingWebSocketServer.onMessage()), but polling here keeps
        // every UI update on the EDT (javax.swing.Timer fires its listener there) without
        // a second cross-thread callback path, and 500ms is plenty responsive for a status
        // label a human is watching.
        pollTimer = new Timer(POLL_INTERVAL_MS, e -> { pollDataProviders(); reportFrameProgress(); });
        pollTimer.start();
        log("Streaming started on " + host + ":" + port + " (batch size " + this.batchSize + ").");
    }

    /** Periodic (POLL_INTERVAL_MS) live "frames sent vs. confirmed" readout - see {@link
     * StreamingAckTracker#reportProgress} for what this actually means. */
    private synchronized void reportFrameProgress() {
        StreamingAckTracker.reportProgress(framesSent, server, onProgress);
    }

    public synchronized void stop() {
        if (!running) {
            return;
        }
        if (pollTimer != null) {
            pollTimer.stop();
            pollTimer = null;
        }
        for (DataProvider dp : registeredProviders) {
            try {
                dp.unregisterForEvents(this);
            } catch (Exception e) {
                // Provider may already be closed (e.g. its window was closed concurrently); ignore.
            }
        }
        registeredProviders.clear();
        pendingBatch.clear();
        running = false;

        final StreamingWebSocketServer s = server;
        if (s != null) {
            s.sendStop();
            final int sentThisSession = framesSent;
            // Give connected webSMLM clients a moment to reply with their own
            // confirmed frame count (StreamingWebSocketServer's ack/stopAck, see its
            // Javadoc) before actually tearing the socket down. Runs via
            // javax.swing.Timer (same non-blocking EDT mechanism pollTimer already
            // uses above) rather than Thread.sleep(), since stop() is called directly
            // from the dialog's ActionListener and must not freeze Micro-Manager's UI
            // thread. server/stopGraceTimer stay non-null until finishStop() runs, so
            // start() (above) refuses a fast Start-right-after-Stop instead of racing
            // this same port.
            stopGraceTimer = new Timer(STOP_ACK_GRACE_MS, e -> finishStop(s, sentThisSession));
            stopGraceTimer.setRepeats(false);
            stopGraceTimer.start();
        }
        log("Streaming stopped.");
    }

    /** Delayed second half of stop(): checks each client's confirmed frame count against
     * what this session actually sent (see {@link StreamingAckTracker#checkFinalCounts}),
     * then actually closes the socket server. See stop()'s own comment for why this is
     * delayed rather than run inline. */
    private synchronized void finishStop(StreamingWebSocketServer s, int sentThisSession) {
        stopGraceTimer = null;
        StreamingAckTracker.checkFinalCounts(sentThisSession, s, this::log);
        try {
            s.stop(1000);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        if (server == s) {
            server = null;
        }
    }

    /**
     * Reconciles {@link #registeredProviders} against whatever MM is currently showing a
     * display for - registers on anything new (a fresh Snap/Live/MDA datastore), unregisters
     * from anything that's gone (its display window was closed). Runs once synchronously from
     * {@link #start} and then every {@value #POLL_INTERVAL_MS} ms via {@link #pollTimer}.
     *
     * Also separately polls {@link Studio#album()}'s own {@link Datastore} - user-confirmed
     * broken without this (Live/Snap/MDA all worked, Album did not). Unlike Live/Snap/MDA,
     * pressing the Album button does not go through DisplayManager#createDisplay() the same
     * way (confirmed via javap against a real MM 2.0.3 install: Studio.album() returns an
     * Album backed by its own Datastore, entirely independent of getAllDataViewers()'s own
     * list), so it was never picked up by the viewer-only polling above regardless of whether
     * an Album window happened to be open. Datastore extends DataProvider directly, so it
     * registers on studio.album().getDatastore() exactly the same way as any display's own
     * DataProvider - no separate event-handling path needed.
     */
    private void pollDataProviders() {
        Set<DataProvider> currentSet = new HashSet<>();

        try {
            List<DataViewer> viewers = studio.displays().getAllDataViewers();
            for (DataViewer viewer : viewers) {
                DataProvider dp = viewer.getDataProvider();
                currentSet.add(dp);
                registerProvider(dp);
            }
        } catch (Exception e) {
            // Displays subsystem not ready yet; try again on the next tick. Don't return early -
            // the Album check below is independent and should still run this tick.
        }

        try {
            Datastore albumStore = studio.album().getDatastore();
            if (albumStore != null) {
                currentSet.add(albumStore);
                registerProvider(albumStore);
            }
        } catch (Exception e) {
            // Album subsystem not ready yet (e.g. never used this session); try again next tick.
        }

        for (DataProvider dp : registeredProviders) {
            if (!currentSet.contains(dp)) {
                unregisterProvider(dp);
            }
        }
    }

    private void registerProvider(DataProvider dp) {
        if (dp != null && registeredProviders.add(dp)) {
            dp.registerForEvents(this);
        }
    }

    private void unregisterProvider(DataProvider dp) {
        if (dp != null && registeredProviders.remove(dp)) {
            try {
                dp.unregisterForEvents(this);
            } catch (Exception e) {
                // Already closed; nothing to do.
            }
        }
    }

    /** Fired on a DataProvider's own event bus for every new frame it receives. */
    @Subscribe
    public void onNewImage(DataProviderHasNewImageEvent event) {
        List<Image> toSend = null;
        synchronized (this) {
            if (!running) {
                return;
            }
            pendingBatch.add(event.getImage());
            if (pendingBatch.size() >= batchSize) {
                toSend = new ArrayList<>(pendingBatch);
                pendingBatch.clear();
            }
        }
        if (toSend != null) {
            sendBatch(toSend);
        }
    }

    private void sendBatch(List<Image> images) {
        try {
            byte[] tiffBytes = ImageJTiffChunkEncoder.encode(images);
            StreamingWebSocketServer s;
            synchronized (this) {
                s = server;
            }
            if (s != null) {
                s.sendChunk(tiffBytes);
                // Only counted once actually handed off to sendChunk() - an encode
                // failure above is already logged in the catch below and deliberately
                // excluded here, so finishStop()'s comparison stays focused on loss
                // that isn't already explained by a logged local error.
                synchronized (this) {
                    framesSent += images.size();
                }
            }
        } catch (Exception e) {
            log("Failed to encode/send chunk: " + e.getMessage());
        }
    }

    private void log(String msg) {
        if (logger != null) {
            logger.accept(msg);
        }
    }
}
