/**
 * Styles master — Figma Plugin Sandbox (code.ts)
 *
 * This file runs inside the Figma sandbox and has full access to the Figma
 * document API.  It communicates with the plugin UI (ui.html) via the
 * structured-clone message-passing bridge.
 *
 * Message contract:
 *   UI  → Sandbox:  { type: 'request-image' }
 *   Sandbox → UI:   { type: 'image-ready',   base64: string }
 *                   { type: 'error',          message: string }
 */

// ---------------------------------------------------------------------------
// Plugin initialisation
// ---------------------------------------------------------------------------

/**
 * Open the plugin UI as a floating panel.
 * Width/height are tuned for a comfortable chatbot widget inside Figma.
 */
figma.showUI(__html__, {
  width: 350,
  height: 600,
  title: 'Styles master',
  themeColors: true,
});

// ---------------------------------------------------------------------------
// Utility: Uint8Array → Base64 string
// ---------------------------------------------------------------------------

/**
 * Convert a raw byte array (returned by exportAsync) to a Base64-encoded
 * string suitable for embedding in a JSON payload.
 *
 * `btoa` is NOT available in the Figma sandbox, so we use the first-party
 * `figma.base64Encode()` helper which is purpose-built for this task.
 *
 * @param bytes - Raw PNG bytes from node.exportAsync()
 * @returns     Base64-encoded string (no data-URI prefix)
 */
function uint8ArrayToBase64(bytes: Uint8Array): string {
  return figma.base64Encode(bytes);
}

// ---------------------------------------------------------------------------
// Utility: send a typed error back to the UI
// ---------------------------------------------------------------------------

/**
 * Helper to post a structured error message back to the UI layer so the
 * chatbot can surface it as a chat bubble rather than silently failing.
 *
 * @param message - Human-readable error description
 */
function sendError(message: string): void {
  figma.ui.postMessage({ type: 'error', message });
}

// ---------------------------------------------------------------------------
// Message handler: UI → Sandbox
// ---------------------------------------------------------------------------

figma.ui.onmessage = async (msg: { type: string }) => {
  // -------------------------------------------------------------------------
  // 'request-image': capture the current Figma selection as a PNG and ship
  // the Base64-encoded bytes back to the UI for the /analyze fetch call.
  // -------------------------------------------------------------------------
  if (msg.type === 'request-image') {
    // Guard: the user must have at least one layer selected
    const selection = figma.currentPage.selection;

    if (!selection || selection.length === 0) {
      sendError(
        'No element selected. Please select a layer or frame in Figma before sending a message.',
      );
      return;
    }

    // Work with the first selected node only
    const node = selection[0];

    try {
      // Export the node as a PNG at 2× resolution for sharper AI analysis
      const imageBytes: Uint8Array = await node.exportAsync({
        format: 'PNG',
        constraint: { type: 'SCALE', value: 2 },
      });

      // Encode to Base64 using the Figma-native helper (btoa is unavailable
      // in the sandbox environment)
      const base64String: string = uint8ArrayToBase64(imageBytes);

      // Deliver the encoded image to the UI layer
      figma.ui.postMessage({
        type: 'image-ready',
        base64: base64String,
      });
    } catch (exportError) {
      // Surface any export failures as a user-facing error bubble
      const errMessage =
        exportError instanceof Error ? exportError.message : String(exportError);
      sendError(`Failed to export the selected element: ${errMessage}`);
    }

    return;
  }

  // Unrecognised message types are silently ignored to stay forward-compatible
};
