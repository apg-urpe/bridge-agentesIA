/**
 * Stub for VS Code API — not used in standalone mode.
 * Provides a no-op implementation so existing code that references it doesn't crash.
 */
export const vscode = {
  postMessage: (_msg: unknown) => {},
  getState: () => null,
  setState: (_state: unknown) => {},
};
