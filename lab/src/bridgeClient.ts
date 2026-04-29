/**
 * Bridge API client for URPE AI Lab agent communication.
 * In production (served by the Bridge itself at /office) uses same-origin.
 * In dev or standalone deploy, falls back to VITE_BRIDGE_URL.
 */

function resolveBridgeUrl(): string {
  const envUrl = import.meta.env.VITE_BRIDGE_URL;
  if (envUrl) return envUrl.replace(/\/$/, '');
  if (typeof window !== 'undefined') return window.location.origin;
  return 'https://bridge-agentesia-production.up.railway.app';
}

const BRIDGE_URL = resolveBridgeUrl();
const API_KEY = import.meta.env.VITE_BRIDGE_API_KEY || '';

export interface BridgeAgent {
  agent_id: string;
  display_name: string;
  platform: string;
  trusted: boolean;
  registered_at: string;
}

export interface BridgeMessage {
  message_id: string;
  thread_id: string;
  from_agent: string;
  to_agent: string;
  content: string;
  timestamp: string;
  acked: boolean;
}

export interface BridgeThread {
  thread_id: string;
  participants: string[];
  messages: BridgeMessage[];
  created_at: string;
  last_activity: string;
}

/** Fetch list of registered agents (public, no auth) */
export async function fetchAgents(): Promise<BridgeAgent[]> {
  try {
    const res = await fetch(`${BRIDGE_URL}/v1/agents`);
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : (data.agents || []);
  } catch (e) {
    console.error('[BridgeClient] fetchAgents error:', e);
    return [];
  }
}

/** Fetch threads with messages (requires API key) */
export async function fetchThreads(): Promise<BridgeThread[]> {
  if (!API_KEY) {
    console.warn('[BridgeClient] No API key configured — using demo mode');
    return [];
  }
  try {
    const res = await fetch(`${BRIDGE_URL}/v1/threads`, {
      headers: { 'X-API-Key': API_KEY },
    });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : (data.threads || []);
  } catch (e) {
    console.error('[BridgeClient] fetchThreads error:', e);
    return [];
  }
}

/** Fetch inbox for a specific agent (requires API key) */
export async function fetchInbox(agentId: string): Promise<BridgeMessage[]> {
  if (!API_KEY) return [];
  try {
    const res = await fetch(`${BRIDGE_URL}/v1/inbox/${agentId}`, {
      headers: { 'X-API-Key': API_KEY },
    });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : (data.messages || []);
  } catch (e) {
    console.error('[BridgeClient] fetchInbox error:', e);
    return [];
  }
}

/** Check bridge health */
export async function checkHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${BRIDGE_URL}/v1/health`);
    return res.ok;
  } catch {
    return false;
  }
}
