package org.kjamartens.websmlm.streaming;

import org.java_websocket.WebSocket;

import java.util.Map;
import java.util.function.Consumer;

/**
 * Compares how many frames {@link StreamingController} has actually sent this session against
 * what each connected webSMLM client has confirmed receiving (its own {@code ack}/{@code
 * stopAck} replies, see {@link StreamingWebSocketServer}'s Javadoc). Split out of
 * StreamingController as a stateless pair of read-only checks - it never touches
 * {@code running}/{@code server}/{@code framesSent} directly, only the values the caller
 * already holds under its own synchronized lock, so this class needs no locking of its own.
 */
final class StreamingAckTracker {

    private StreamingAckTracker() {
    }

    /**
     * Periodic (StreamingController.POLL_INTERVAL_MS) live readout of how far behind webSMLM's
     * own confirmations are trailing what's actually been sent this session - NOT the
     * authoritative loss verdict (see {@link #checkFinalCounts}, after stop()'s grace period,
     * which waits for processing to fully catch up first). A transient gap here is normal and
     * expected under continuous streaming (network + detect/fit latency); it's meant as a live
     * "is the pipeline keeping up" signal, most useful when it grows without bound rather than
     * hovering near a small, stable number.
     */
    static void reportProgress(int framesSent, StreamingWebSocketServer server, Consumer<String> onProgress) {
        if (onProgress == null || server == null) {
            return;
        }
        Map<WebSocket, Integer> confirmed = server.getLastFramesReceived();
        if (confirmed.isEmpty()) {
            onProgress.accept(framesSent + " frames sent - no client confirmation yet.");
            return;
        }
        int minConfirmed = Integer.MAX_VALUE;
        for (int v : confirmed.values()) {
            minConfirmed = Math.min(minConfirmed, v);
        }
        int gap = framesSent - minConfirmed;
        onProgress.accept(framesSent + " sent, " + minConfirmed + " confirmed"
                + (gap > 0 ? " (" + gap + " not yet confirmed)" : " - fully caught up."));
    }

    /**
     * Delayed, authoritative check run from {@code StreamingController.finishStop()}: compares
     * each client's confirmed frame count against what this session actually sent, and logs a
     * warning on any shortfall. See stop()'s own comment for why this runs after a grace period
     * rather than inline. Does NOT itself touch the socket (that stays lifecycle, in
     * StreamingController) - purely the comparison/logging.
     */
    static void checkFinalCounts(int sentThisSession, StreamingWebSocketServer server, Consumer<String> logger) {
        Map<WebSocket, Integer> confirmed = server.getLastFramesReceived();
        if (confirmed.isEmpty()) {
            logger.accept("No frame-count confirmation received from webSMLM - cannot verify all "
                    + sentThisSession + " sent frames arrived (no client connected, or it never acked).");
            return;
        }
        for (Map.Entry<WebSocket, Integer> e : confirmed.entrySet()) {
            int received = e.getValue();
            String addr = String.valueOf(e.getKey().getRemoteSocketAddress());
            if (received >= sentThisSession) {
                logger.accept("webSMLM at " + addr + " confirmed all " + sentThisSession + " frames received.");
            } else {
                logger.accept("⚠ webSMLM at " + addr + " only confirmed " + received + "/" + sentThisSession
                        + " frames received (" + (sentThisSession - received) + " missing).");
            }
        }
    }
}
