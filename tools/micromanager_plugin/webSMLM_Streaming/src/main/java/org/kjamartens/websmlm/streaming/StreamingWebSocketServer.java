package org.kjamartens.websmlm.streaming;

import org.java_websocket.WebSocket;
import org.java_websocket.handshake.ClientHandshake;
import org.java_websocket.server.WebSocketServer;

import java.net.InetSocketAddress;
import java.nio.ByteBuffer;
import java.util.HashMap;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArraySet;
import java.util.function.Consumer;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * WebSocket server side of webSMLM's live-streaming protocol (see webSMLM.html's
 * streamWsConnect() and tools/test_stream_demo.py, which this class replaces with a real
 * Micro-Manager acquisition source).
 *
 * Wire protocol implemented here:
 *  - Each chunk of frames is sent as ONE binary WebSocket message: the raw bytes of an
 *    ImageJ-style TIFF stack. The WebSocket message boundary IS the chunk boundary -
 *    no length prefix, no wrapper.
 *  - A session is ended without closing the socket by sending a text message
 *    {"cmd":"stop"}.
 *  - webSMLM talks back over the same connection, purely advisory (no backpressure or
 *    retransmission - a slow/lossy client is still the caller's problem, not this
 *    class's): {"cmd":"ack","framesReceived":N,"chunkCount":C,"ok":bool} after every
 *    chunk it processes, and {"cmd":"stopAck","framesReceived":N,"chunkCount":C} once it
 *    has handled our own "stop" message - the authoritative final count, since webSMLM
 *    processes messages strictly in arrival order. onMessage() below parses these and
 *    stashes the latest count per connection so StreamingController can compare it
 *    against how many frames it actually sent and warn on loss.
 */
public class StreamingWebSocketServer extends WebSocketServer {

    // Matches the small, fixed-shape JSON webSMLM itself always produces for these two
    // message kinds (see webSMLM.html's streamWsConnect()) - a hand-rolled scan rather
    // than pulling in a JSON library dependency for two integer fields.
    private static final Pattern FRAMES_RECEIVED_RE = Pattern.compile("\"framesReceived\"\\s*:\\s*(\\d+)");

    private final Set<WebSocket> clients = new CopyOnWriteArraySet<>();
    private final Map<WebSocket, Integer> lastFramesReceived = new ConcurrentHashMap<>();
    private final Consumer<String> logger;
    private final Consumer<Integer> onClientCountChanged;

    public StreamingWebSocketServer(InetSocketAddress address, Consumer<String> logger,
                                     Consumer<Integer> onClientCountChanged) {
        super(address);
        this.logger = logger;
        this.onClientCountChanged = onClientCountChanged;
        setReuseAddr(true);
    }

    @Override
    public void onOpen(WebSocket conn, ClientHandshake handshake) {
        clients.add(conn);
        log("webSMLM client connected: " + conn.getRemoteSocketAddress());
        onClientCountChanged.accept(clients.size());
    }

    @Override
    public void onClose(WebSocket conn, int code, String reason, boolean remote) {
        clients.remove(conn);
        lastFramesReceived.remove(conn);
        log("webSMLM client disconnected: " + conn.getRemoteSocketAddress());
        onClientCountChanged.accept(clients.size());
    }

    @Override
    public void onMessage(WebSocket conn, String message) {
        // The only text messages webSMLM ever sends back are "ack"/"stopAck" (see the
        // class Javadoc) - both carry a "framesReceived" field, which is all
        // StreamingController needs (it doesn't need to distinguish ack from stopAck;
        // it only reads this map after its own grace-period wait post-stop). Anything
        // else (a malformed message, or a future message kind) is ignored.
        Matcher m = FRAMES_RECEIVED_RE.matcher(message);
        if (m.find()) {
            try {
                lastFramesReceived.put(conn, Integer.parseInt(m.group(1)));
            } catch (NumberFormatException e) {
                // Ignore - a malformed count is no worse than no count at all.
            }
        }
    }

    @Override
    public void onError(WebSocket conn, Exception ex) {
        log("WebSocket error: " + ex.getMessage());
    }

    @Override
    public void onStart() {
        log("webSMLM_Streaming server listening on " + getAddress());
    }

    /** Broadcasts one TIFF-encoded chunk to every currently connected client. */
    public void sendChunk(byte[] tiffBytes) {
        if (clients.isEmpty()) {
            return;
        }
        ByteBuffer buf = ByteBuffer.wrap(tiffBytes);
        for (WebSocket ws : clients) {
            if (ws.isOpen()) {
                ws.send(buf.duplicate());
            }
        }
    }

    /** Ends the current streaming session for every connected client, without disconnecting them. */
    public void sendStop() {
        for (WebSocket ws : clients) {
            if (ws.isOpen()) {
                ws.send("{\"cmd\":\"stop\"}");
            }
        }
    }

    public int getClientCount() {
        return clients.size();
    }

    /** Defensive-copy snapshot of the latest confirmed frame count per connected client. */
    public Map<WebSocket, Integer> getLastFramesReceived() {
        return new HashMap<>(lastFramesReceived);
    }

    private void log(String msg) {
        if (logger != null) {
            logger.accept(msg);
        }
    }
}
