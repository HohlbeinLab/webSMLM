package org.kjamartens.websmlm.streaming;

import org.micromanager.MenuPlugin;
import org.micromanager.Studio;
import org.scijava.plugin.Plugin;
import org.scijava.plugin.SciJavaPlugin;

/**
 * Micro-Manager 2.0 MenuPlugin entry point for webSMLM_Streaming.
 *
 * Appears in MM's Plugins menu; selecting it opens {@link StreamingConfigDialog}, which owns
 * the actual WebSocket server + frame-batching/encoding lifecycle (see
 * {@link StreamingController}). This class itself only wires MM's plugin-loader hooks to that
 * dialog - it holds no acquisition/networking logic of its own.
 */
@Plugin(type = MenuPlugin.class)
public class WebSMLMStreamingPlugin implements MenuPlugin, SciJavaPlugin {

    public static final String MENU_NAME = "webSMLM Streaming";
    public static final String TOOLTIP = "Stream live camera frames to a webSMLM browser tab over WebSocket";

    private Studio studio_;
    private StreamingConfigDialog dialog_;

    @Override
    public void setContext(Studio studio) {
        studio_ = studio;
    }

    @Override
    public String getSubMenu() {
        // Empty string = top level of the Plugins menu.
        return "";
    }

    @Override
    public void onPluginSelected() {
        if (dialog_ == null) {
            dialog_ = new StreamingConfigDialog(studio_.app().getMainWindow(), studio_);
        }
        dialog_.setVisible(true);
        dialog_.toFront();
    }

    @Override
    public String getName() {
        return MENU_NAME;
    }

    @Override
    public String getHelpText() {
        return TOOLTIP;
    }

    @Override
    public String getVersion() {
        return "0.1.0";
    }

    @Override
    public String getCopyright() {
        return "K.J.A. Martens, 2026";
    }
}
