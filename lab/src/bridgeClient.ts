/**
 * Bridge API client for the URPE AI Lab pixel office.
 *
 * Same-origin by default (the office is served by the bridge itself at
 * /office/). Override with VITE_BRIDGE_URL when the SPA runs separately.
 *
 * The pixel office is a public live view: it consumes the SSE feed at
 * `/v1/office/feed` and the public agents list at `/v1/agents`. No API key
 * required. If the bridge has REGISTRATION_TOKEN set, the user can supply
 * the gate token via VITE_BRIDGE_GATE_TOKEN or via the dashboard's
 * `bridge-agentesia-gate-token` localStorage key (same origin → shared).
 */

export const GATE_STORAGE_KEY = 'bridge-agentesia-gate-token';

function resolveBridgeUrl(): string {
  const envUrl = import.meta.env.VITE_BRIDGE_URL;
  if (envUrl) return envUrl.replace(/\/$/, '');
  if (typeof window !== 'undefined') return window.location.origin;
  return '';
}

function resolveGateToken(): string {
  const envToken = import.meta.env.VITE_BRIDGE_GATE_TOKEN;
  if (envToken) return String(envToken);
  if (typeof localStorage !== 'undefined') {
    const stored = localStorage.getItem(GATE_STORAGE_KEY);
    if (stored) return stored;
  }
  return '';
}

const BRIDGE_URL = resolveBridgeUrl();

export function getStoredGateToken(): string {
  if (typeof localStorage === 'undefined') return '';
  return localStorage.getItem(GATE_STORAGE_KEY) || '';
}

export function setStoredGateToken(token: string): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(GATE_STORAGE_KEY, token);
}

export function clearStoredGateToken(): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.removeItem(GATE_STORAGE_KEY);
}

/** GET /v1/gate/status — does the bridge require an access token? */
export async function fetchGateStatus(): Promise<{ required: boolean }> {
  try {
    const res = await fetch(`${BRIDGE_URL}/v1/gate/status`, { cache: 'no-store' });
    if (!res.ok) return { required: false };
    const data = await res.json();
    return { required: !!data.required };
  } catch {
    return { required: false };
  }
}

/** POST /v1/gate/check — validate a candidate token. Throws on failure. */
export async function verifyGateToken(token: string): Promise<void> {
  const res = await fetch(`${BRIDGE_URL}/v1/gate/check`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'X-Registration-Token': token } : {}),
    },
    cache: 'no-store',
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body && typeof body.detail === 'string') detail = body.detail;
    } catch { /* ignore */ }
    throw new Error(detail);
  }
}

export interface BridgeAgent {
  agent_id: string;
  display_name: string;
  platform: string | null;
  trusted: boolean;
  created_at: string;
  /** Self-service appearance overrides; null = use hash-derived defaults. */
  palette: number | null;
  hue_shift: number | null;
  /** Optional owner identity (nombre y apellido). Null when not set. */
  owner_first_name: string | null;
  owner_last_name: string | null;
}

/** Shape emitted by GET /v1/office/feed (SSE `data:` payload). */
export interface OfficeFeedMessage {
  type: 'message';
  id: string;
  from: string;
  to: string;
  message: string;
  thread_id: string | null;
  created_at: string;
}

export interface OfficeFeedHello {
  type: 'hello';
  at: string;
}

export type OfficeFeedEvent = OfficeFeedMessage | OfficeFeedHello;

/** Last N messages persisted in the bridge DB, oldest first. Gate-token
 * protected (same contract as /v1/office/feed). */
export async function fetchOfficeHistory(limit = 200): Promise<OfficeFeedMessage[]> {
  const token = resolveGateToken();
  const params = new URLSearchParams({ limit: String(limit) });
  if (token) params.set('token', token);
  try {
    const res = await fetch(`${BRIDGE_URL}/v1/office/history?${params.toString()}`, { cache: 'no-store' });
    if (!res.ok) return [];
    const data = await res.json();
    if (!data || !Array.isArray(data.messages)) return [];
    return data.messages.map((m: Record<string, unknown>) => ({
      type: 'message' as const,
      id: String(m.id),
      from: String(m.from),
      to: String(m.to),
      message: String(m.message),
      thread_id: m.thread_id == null ? null : String(m.thread_id),
      created_at: String(m.created_at),
    }));
  } catch (e) {
    console.error('[BridgeClient] fetchOfficeHistory error:', e);
    return [];
  }
}

/** Fetch list of registered agents (public). */
export async function fetchAgents(): Promise<BridgeAgent[]> {
  try {
    const res = await fetch(`${BRIDGE_URL}/v1/agents`, { cache: 'no-store' });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : (data.agents || []);
  } catch (e) {
    console.error('[BridgeClient] fetchAgents error:', e);
    return [];
  }
}

/** Check bridge health (used as a connectivity ping). */
export async function checkHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${BRIDGE_URL}/v1/health`, { cache: 'no-store' });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Subscribe to the SSE feed of new messages. Returns a cancel fn.
 * Auto-reconnects with exponential backoff up to 15s.
 */
export function connectOfficeFeed(
  onEvent: (event: OfficeFeedEvent) => void,
  onStatus?: (status: 'connecting' | 'open' | 'closed') => void,
): () => void {
  let cancelled = false;
  let source: EventSource | null = null;
  let retryDelay = 1000;
  let retryHandle: number | null = null;

  function open(): void {
    if (cancelled) return;
    onStatus?.('connecting');

    const token = resolveGateToken();
    const qs = token ? `?token=${encodeURIComponent(token)}` : '';
    source = new EventSource(`${BRIDGE_URL}/v1/office/feed${qs}`);

    source.onopen = () => {
      retryDelay = 1000;
      onStatus?.('open');
    };

    source.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data) as OfficeFeedEvent;
        onEvent(data);
      } catch (err) {
        console.warn('[BridgeClient] bad SSE payload', err);
      }
    };

    source.onerror = () => {
      onStatus?.('closed');
      source?.close();
      source = null;
      if (cancelled) return;
      retryHandle = window.setTimeout(open, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 15000);
    };
  }

  open();

  return () => {
    cancelled = true;
    if (retryHandle !== null) clearTimeout(retryHandle);
    source?.close();
    source = null;
  };
}
