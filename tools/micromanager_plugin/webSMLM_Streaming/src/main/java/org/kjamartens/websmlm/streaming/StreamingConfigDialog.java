package org.kjamartens.websmlm.streaming;

import org.micromanager.Studio;
import org.micromanager.propertymap.MutablePropertyMapView;

import javax.swing.*;
import java.awt.*;
import java.io.IOException;

/**
 * Swing settings window for webSMLM_Streaming: host, port, batch size (frames per chunk),
 * a Start/Stop toggle, and a small status line showing connected-client count. Settings are
 * persisted through Micro-Manager's per-user profile (PropertyMap), so they survive restarts
 * of MM, the same way MM's own built-in plugins persist their settings.
 */
public class StreamingConfigDialog extends JDialog {

    private static final String KEY_HOST = "host";
    private static final String KEY_PORT = "port";
    private static final String KEY_BATCH = "batchSize";

    private static final String DEFAULT_HOST = "localhost";
    private static final int DEFAULT_PORT = 8765;
    private static final int DEFAULT_BATCH = 1;

    private final Studio studio;
    private final StreamingController controller;

    private final JTextField hostField = new JTextField(DEFAULT_HOST, 14);
    private final JSpinner portSpinner = new JSpinner(new SpinnerNumberModel(DEFAULT_PORT, 1, 65535, 1));
    private final JSpinner batchSpinner = new JSpinner(new SpinnerNumberModel(DEFAULT_BATCH, 1, 100000, 1));
    private final JButton startStopButton = new JButton("Start");
    private final JLabel statusLabel = new JLabel("Not running.");
    private final JLabel frameProgressLabel = new JLabel(" ");
    private final JTextArea logArea = new JTextArea(8, 40);

    public StreamingConfigDialog(Frame owner, Studio studio) {
        super(owner, "webSMLM Streaming", false);
        this.studio = studio;
        this.controller = new StreamingController(studio, this::appendLog);

        loadSettings();
        buildUi();
        pack();
        setLocationRelativeTo(owner);
    }

    private void buildUi() {
        JPanel form = new JPanel(new GridBagLayout());
        GridBagConstraints c = new GridBagConstraints();
        c.insets = new Insets(4, 4, 4, 4);
        c.anchor = GridBagConstraints.WEST;

        c.gridx = 0; c.gridy = 0; form.add(new JLabel("Host:"), c);
        c.gridx = 1; form.add(hostField, c);

        c.gridx = 0; c.gridy = 1; form.add(new JLabel("Port:"), c);
        c.gridx = 1; form.add(portSpinner, c);

        c.gridx = 0; c.gridy = 2; form.add(new JLabel("Frames per chunk:"), c);
        c.gridx = 1; form.add(batchSpinner, c);

        c.gridx = 0; c.gridy = 3; c.gridwidth = 2;
        c.anchor = GridBagConstraints.CENTER;
        form.add(startStopButton, c);

        c.gridy = 4;
        form.add(statusLabel, c);

        c.gridy = 5;
        frameProgressLabel.setFont(frameProgressLabel.getFont().deriveFont(Font.PLAIN, 11f));
        form.add(frameProgressLabel, c);

        startStopButton.addActionListener(e -> onStartStopClicked());

        logArea.setEditable(false);
        logArea.setLineWrap(true);

        JPanel content = new JPanel(new BorderLayout(8, 8));
        content.setBorder(BorderFactory.createEmptyBorder(10, 10, 10, 10));
        content.add(form, BorderLayout.NORTH);
        content.add(new JScrollPane(logArea), BorderLayout.CENTER);

        JLabel hint = new JLabel("<html>Streams every Snap/Live/MDA frame to any connected "
                + "webSMLM tab as ImageJ TIFF chunks over WebSocket.<br>"
                + "In webSMLM, set \"Live streaming\" &rarr; WebSocket URL to "
                + "ws://&lt;host&gt;:&lt;port&gt; and click Connect.</html>");
        hint.setFont(hint.getFont().deriveFont(Font.PLAIN, 11f));
        content.add(hint, BorderLayout.SOUTH);

        setContentPane(content);

        addWindowListener(new java.awt.event.WindowAdapter() {
            @Override
            public void windowClosing(java.awt.event.WindowEvent e) {
                saveSettings();
            }
        });
    }

    private void onStartStopClicked() {
        if (controller.isRunning()) {
            controller.stop();
            startStopButton.setText("Start");
            setFieldsEnabled(true);
            statusLabel.setText("Not running.");
            frameProgressLabel.setText(" ");
            return;
        }

        String host = hostField.getText().trim();
        if (host.isEmpty()) {
            host = DEFAULT_HOST;
            hostField.setText(host);
        }
        int port = (Integer) portSpinner.getValue();
        int batchSize = (Integer) batchSpinner.getValue();

        try {
            controller.start(host, port, batchSize, this::onClientCountChanged, this::onProgress);
            startStopButton.setText("Stop");
            setFieldsEnabled(false);
            statusLabel.setText("Listening on " + host + ":" + port + " - 0 client(s) connected.");
            frameProgressLabel.setText(" ");
            saveSettings();
        } catch (IOException | IllegalStateException ex) {
            appendLog("Failed to start: " + ex.getMessage());
            JOptionPane.showMessageDialog(this, "Could not start streaming server:\n" + ex.getMessage(),
                    "webSMLM Streaming", JOptionPane.ERROR_MESSAGE);
        }
    }

    private void onClientCountChanged(int count) {
        SwingUtilities.invokeLater(() -> {
            if (controller.isRunning()) {
                statusLabel.setText("Listening on " + hostField.getText().trim() + ":"
                        + portSpinner.getValue() + " - " + count + " client(s) connected.");
            }
        });
    }

    /** Live "frames sent vs. confirmed" readout (see StreamingController.reportFrameProgress()),
     * refreshed roughly every 500ms while a session is running. Already called on the EDT
     * (javax.swing.Timer's own listener thread), same as onClientCountChanged() ends up on
     * via invokeLater - no extra dispatch needed here. */
    private void onProgress(String text) {
        frameProgressLabel.setText(text);
    }

    private void setFieldsEnabled(boolean enabled) {
        hostField.setEnabled(enabled);
        portSpinner.setEnabled(enabled);
        batchSpinner.setEnabled(enabled);
    }

    private void appendLog(String msg) {
        SwingUtilities.invokeLater(() -> {
            logArea.append(msg + "\n");
            logArea.setCaretPosition(logArea.getDocument().getLength());
        });
        if (studio != null) {
            studio.logs().logMessage("[webSMLM_Streaming] " + msg);
        }
    }

    private void loadSettings() {
        try {
            MutablePropertyMapView settings = studio.profile().getSettings(StreamingConfigDialog.class);
            hostField.setText(settings.getString(KEY_HOST, DEFAULT_HOST));
            portSpinner.setValue(settings.getInteger(KEY_PORT, DEFAULT_PORT));
            batchSpinner.setValue(settings.getInteger(KEY_BATCH, DEFAULT_BATCH));
        } catch (Exception e) {
            // Fall back to the hard-coded defaults already set on the fields/spinners above -
            // a first run (or an unexpected profile API shape) shouldn't block the dialog.
        }
    }

    private void saveSettings() {
        try {
            MutablePropertyMapView settings = studio.profile().getSettings(StreamingConfigDialog.class);
            settings.putString(KEY_HOST, hostField.getText().trim());
            settings.putInteger(KEY_PORT, (Integer) portSpinner.getValue());
            settings.putInteger(KEY_BATCH, (Integer) batchSpinner.getValue());
        } catch (Exception e) {
            appendLog("Could not save settings: " + e.getMessage());
        }
    }

    /** Called when the whole plugin/dialog is being torn down (e.g. MM shutting down). */
    public void shutdown() {
        if (controller.isRunning()) {
            controller.stop();
        }
        saveSettings();
    }
}
