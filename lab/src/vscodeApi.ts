/**
 * VS Code API replacement for the standalone web app.
 *
 * The legacy hook (useEditorActions) calls `vscode.postMessage({ type: 'saveLayout', layout })`
 * on every debounced edit. In standalone mode we persist drafts to localStorage so
 * edits survive a page reload, and expose a hook so the App can react to saves.
 *
 * Other unsupported messages are no-ops.
 */

const LAYOUT_DRAFT_KEY = 'urpe-office-layout-draft';

type SaveListener = (layout: unknown) => void;
const saveListeners: SaveListener[] = [];

export const vscode = {
  postMessage: (msg: unknown) => {
    if (
      typeof msg === 'object' &&
      msg !== null &&
      'type' in msg &&
      (msg as { type: string }).type === 'saveLayout' &&
      'layout' in msg
    ) {
      const layout = (msg as { layout: unknown }).layout;
      try {
        localStorage.setItem(LAYOUT_DRAFT_KEY, JSON.stringify(layout));
      } catch {
        // Quota exceeded or unavailable — silently skip persistence.
      }
      for (const listener of saveListeners) listener(layout);
    }
  },
  getState: () => null,
  setState: (_state: unknown) => {},
};

export function getDraftLayout(): unknown | null {
  try {
    const raw = localStorage.getItem(LAYOUT_DRAFT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function clearDraftLayout(): void {
  try {
    localStorage.removeItem(LAYOUT_DRAFT_KEY);
  } catch {
    // No-op.
  }
}

export function onLayoutSaved(listener: SaveListener): () => void {
  saveListeners.push(listener);
  return () => {
    const idx = saveListeners.indexOf(listener);
    if (idx >= 0) saveListeners.splice(idx, 1);
  };
}
