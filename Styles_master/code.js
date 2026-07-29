"use strict";
/**
 * DesignMate AI — Figma Plugin Sandbox (code.js)
 *
 * Runs inside the Figma sandbox. Handles:
 *   - Layer export (PNG → base64) for AI analysis
 *   - Color / font extraction from selected layer
 *   - Folder CRUD via figma.clientStorage (persists across reloads)
 *
 * Message contract (UI → Sandbox):
 *   { type: 'request-image' }
 *   { type: 'get-layer-info' }
 *   { type: 'get-folders' }
 *   { type: 'create-folder',       name, folderType }
 *   { type: 'rename-folder',       folderId, newName }
 *   { type: 'delete-folder',       folderId }
 *   { type: 'add-color-to-folder', folderId, color: {hex, name, rgb} }
 *   { type: 'add-font-to-folder',  folderId, font: {fontName, fontSize, fontWeight, name} }
 *   { type: 'delete-folder-item',  folderId, itemIndex }
 */

const STORAGE_KEY = 'designmate-folders';

// ── Open UI ────────────────────────────────────────────────────────────────
figma.showUI(__html__, {
  width: 380,
  height: 620,
  title: 'DesignMate AI',
  themeColors: true,
});

// ── Helpers ─────────────────────────────────────────────────────────────────
function sendError(message) {
  figma.ui.postMessage({ type: 'error', message });
}

function uint8ArrayToBase64(bytes) {
  // figma.base64Encode exists in recent plugin runtimes; fall back to manual
  if (typeof figma.base64Encode === 'function') {
    return figma.base64Encode(bytes);
  }
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/** RGB (0–1 floats) → "#RRGGBB" */
function rgbToHex(r, g, b) {
  const toHex = (v) => Math.round(v * 255).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`.toUpperCase();
}

/**
 * Load folders from clientStorage, returning a safe default if absent.
 * Shape: { folders: Array<{ id, name, type, items: [] }> }
 */
async function loadFolders() {
  try {
    const stored = await figma.clientStorage.getAsync(STORAGE_KEY);
    if (stored && stored.folders) return stored;
  } catch (_) { /* first run */ }
  return { folders: [] };
}

async function saveFolders(data) {
  await figma.clientStorage.setAsync(STORAGE_KEY, data);
}

function generateId() {
  return `f_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

/** Extract color + font info from a node (shared by selectionchange and get-layer-info) */
function extractLayerInfo(node) {
  let color = null;
  let font = null;

  // Fills — guard against figma.mixed (mixed fills on multi-selected text)
  if ('fills' in node && Array.isArray(node.fills)) {
    const solidFill = node.fills.find(f => f.type === 'SOLID' && f.visible !== false);
    if (solidFill) {
      const { r, g, b } = solidFill.color;
      color = {
        hex: rgbToHex(r, g, b),
        rgb: { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255) },
        opacity: solidFill.opacity !== undefined ? solidFill.opacity : 1,
      };
    }
  }

  // Font — only TEXT nodes; guard against figma.mixed (mixed styles)
  if (node.type === 'TEXT') {
    const rawFontName = node.fontName;
    const rawFontSize = node.fontSize;
    // figma.mixed means the text has mixed styles — skip those properties safely
    const isMixedName = rawFontName === figma.mixed;
    const isMixedSize = rawFontSize === figma.mixed;
    font = {
      fontName:   isMixedName ? 'Mixed' : (typeof rawFontName === 'object' ? rawFontName.family : String(rawFontName)),
      fontStyle:  isMixedName ? '' : (typeof rawFontName === 'object' ? rawFontName.style : ''),
      fontSize:   isMixedSize ? '' : rawFontSize,
      // Figma has no .fontWeight — derive it from fontStyle string
      fontWeight: isMixedName ? '' : (typeof rawFontName === 'object' ? rawFontName.style : ''),
      lineHeight: node.lineHeight === figma.mixed ? '' : node.lineHeight,
    };
  }

  return { color, font };
}

// ── Selection change: auto-push layer info to UI ────────────────────────────
figma.on('selectionchange', () => {
  const selection = figma.currentPage.selection;
  if (!selection || selection.length === 0) {
    figma.ui.postMessage({ type: 'layer-info', color: null, font: null, nodeName: null });
    return;
  }
  const node = selection[0];
  const { color, font } = extractLayerInfo(node);
  figma.ui.postMessage({ type: 'layer-info', color, font, nodeName: node.name });
});

// ── Message handler ──────────────────────────────────────────────────────────
figma.ui.onmessage = async (msg) => {

  // ── request-image: export selected node as PNG base64 ──────────────────
  if (msg.type === 'request-image') {
    const selection = figma.currentPage.selection;
    if (!selection || selection.length === 0) {
      sendError('لم يتم تحديد أي عنصر. يرجى تحديد طبقة أو إطار في Figma أولاً.');
      return;
    }
    const node = selection[0];
    try {
      const imageBytes = await node.exportAsync({
        format: 'PNG',
        constraint: { type: 'SCALE', value: 2 },
      });
      figma.ui.postMessage({ type: 'image-ready', base64: uint8ArrayToBase64(imageBytes) });
    } catch (err) {
      sendError(`فشل تصدير العنصر: ${err instanceof Error ? err.message : String(err)}`);
    }
    return;
  }

  // ── get-layer-info: extract color + font from selected node ────────────
  if (msg.type === 'get-layer-info') {
    const selection = figma.currentPage.selection;
    if (!selection || selection.length === 0) {
      figma.ui.postMessage({ type: 'layer-info', color: null, font: null, nodeName: null });
      return;
    }
    const node = selection[0];
    const { color, font } = extractLayerInfo(node);
    figma.ui.postMessage({ type: 'layer-info', color, font, nodeName: node.name });
    return;
  }

  // ── get-folders ────────────────────────────────────────────────────────
  if (msg.type === 'get-folders') {
    const data = await loadFolders();
    figma.ui.postMessage({ type: 'folders-data', folders: data.folders });
    return;
  }

  // ── create-folder ──────────────────────────────────────────────────────
  if (msg.type === 'create-folder') {
    const data = await loadFolders();
    const folder = {
      id: generateId(),
      name: msg.name || 'مجلد جديد',
      folderType: msg.folderType || 'mixed', // 'colors' | 'fonts' | 'mixed'
      items: [],
    };
    data.folders.push(folder);
    await saveFolders(data);
    figma.ui.postMessage({ type: 'folders-data', folders: data.folders });
    return;
  }

  // ── rename-folder ──────────────────────────────────────────────────────
  if (msg.type === 'rename-folder') {
    const data = await loadFolders();
    const folder = data.folders.find(f => f.id === msg.folderId);
    if (folder) { folder.name = msg.newName; await saveFolders(data); }
    figma.ui.postMessage({ type: 'folders-data', folders: data.folders });
    return;
  }

  // ── delete-folder ──────────────────────────────────────────────────────
  if (msg.type === 'delete-folder') {
    const data = await loadFolders();
    data.folders = data.folders.filter(f => f.id !== msg.folderId);
    await saveFolders(data);
    figma.ui.postMessage({ type: 'folders-data', folders: data.folders });
    return;
  }

  // ── add-color-to-folder ────────────────────────────────────────────────
  if (msg.type === 'add-color-to-folder') {
    const data = await loadFolders();
    const folder = data.folders.find(f => f.id === msg.folderId);
    if (folder) {
      folder.items.push({ kind: 'color', ...msg.color });
      await saveFolders(data);
    }
    figma.ui.postMessage({ type: 'folders-data', folders: data.folders });
    return;
  }

  // ── add-font-to-folder ─────────────────────────────────────────────────
  if (msg.type === 'add-font-to-folder') {
    const data = await loadFolders();
    const folder = data.folders.find(f => f.id === msg.folderId);
    if (folder) {
      folder.items.push({ kind: 'font', ...msg.font });
      await saveFolders(data);
    }
    figma.ui.postMessage({ type: 'folders-data', folders: data.folders });
    return;
  }

  // ── delete-folder-item ─────────────────────────────────────────────────
  if (msg.type === 'delete-folder-item') {
    const data = await loadFolders();
    const folder = data.folders.find(f => f.id === msg.folderId);
    if (folder && msg.itemIndex >= 0 && msg.itemIndex < folder.items.length) {
      folder.items.splice(msg.itemIndex, 1);
      await saveFolders(data);
    }
    figma.ui.postMessage({ type: 'folders-data', folders: data.folders });
    return;
  }
};
