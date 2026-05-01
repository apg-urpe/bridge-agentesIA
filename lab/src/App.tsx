import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, FormEvent } from 'react';

import {
  loadAssets,
  dispatchAssetMessages,
  syncAgents,
  startFeed,
  stopFeed,
  loadHistory,
  onNewMessages,
  onAgentsChanged,
  onFeedStatus,
  getCharacterId,
  getAgentDisplayName,
  getAgentEntry,
  type AgentEntry,
  type LiveMessage,
} from './bridgeAdapter.ts';
import {
  clearStoredGateToken,
  fetchGateStatus,
  getStoredGateToken,
  setStoredGateToken,
  verifyGateToken,
} from './bridgeClient.ts';
import { OfficeCanvas } from './office/components/OfficeCanvas.js';
import { ToolOverlay } from './office/components/ToolOverlay.js';
import { EditorState, EditorToolbar } from './office/editor/index.js';
import { expandLayout, type ExpandDirection } from './office/editor/editorActions.js';
import { OfficeState } from './office/engine/officeState.js';
import { setFloorSprites } from './office/floorTiles.js';
import { buildDynamicCatalog } from './office/layout/furnitureCatalog.js';
import { migrateLayoutColors } from './office/layout/layoutSerializer.js';
import { setCharacterTemplates } from './office/sprites/spriteData.js';
import type { OfficeLayout } from './office/types.js';
import { setWallSprites } from './office/wallTiles.js';
import { ZoomControls } from './components/ZoomControls.js';
import { useEditorActions } from './hooks/useEditorActions.js';
import { clearDraftLayout, getDraftLayout } from './vscodeApi.js';

// ── Game state (outside React) ─────────────────────────────────────────────

const officeStateRef = { current: null as OfficeState | null };

function getOfficeState(): OfficeState {
  if (!officeStateRef.current) {
    officeStateRef.current = new OfficeState();
  }
  return officeStateRef.current;
}

// ── Encounter animation ─────────────────────────────────────────────────
//
// On each new message we make the sender walk to an adjacent tile of the
// recipient, show a speech bubble with the message, and linger. Multiple
// messages from the same sender queue up FIFO and chain directly: the agent
// goes recipient→recipient without returning home in between, and only
// walks back to their seat once the queue is empty.

const ENCOUNTER_LINGER_MS = 11000;  // time at each recipient (walk-out + chat)

interface PendingEncounter {
  toAgentId: string;
  text: string;
}

const senderQueues = new Map<number, PendingEncounter[]>();
const busySenders = new Set<number>();

type SetSpeech = (characterId: number, text: string | null) => void;

function enqueueEncounter(
  os: OfficeState,
  fromAgentId: string,
  toAgentId: string,
  text: string,
  setSpeech: SetSpeech,
): void {
  const senderId = getCharacterId(fromAgentId);
  if (senderId === null) return;

  const q = senderQueues.get(senderId) ?? [];
  q.push({ toAgentId, text });
  senderQueues.set(senderId, q);

  if (!busySenders.has(senderId)) {
    pumpQueue(os, senderId, setSpeech);
  }
}

function pumpQueue(os: OfficeState, senderId: number, setSpeech: SetSpeech): void {
  const q = senderQueues.get(senderId);
  const next = q?.shift();
  if (!next) {
    // Queue empty — clear bubble and walk home.
    busySenders.delete(senderId);
    senderQueues.delete(senderId);
    setSpeech(senderId, null);
    const sender = os.characters.get(senderId);
    const senderSeat = sender?.seatId ? os.seats.get(sender.seatId) : null;
    if (senderSeat) {
      os.walkToTile(senderId, senderSeat.seatCol, senderSeat.seatRow);
    }
    return;
  }
  busySenders.add(senderId);
  runEncounter(os, senderId, next, setSpeech, () => {
    pumpQueue(os, senderId, setSpeech);
  });
}

function runEncounter(
  os: OfficeState,
  senderId: number,
  msg: PendingEncounter,
  setSpeech: SetSpeech,
  onDone: () => void,
): void {
  const receiverId = getCharacterId(msg.toAgentId);
  const sender = os.characters.get(senderId);
  const receiver = receiverId !== null ? os.characters.get(receiverId) : undefined;

  const canAnimate = !!sender && !!receiver && receiverId !== senderId;
  const target = (canAnimate && sender)
    ? pickAdjacentWalkable(os, receiver!.tileCol, receiver!.tileRow, sender.tileCol, sender.tileRow)
    : null;

  if (canAnimate && target && os.walkToTile(senderId, target.col, target.row)) {
    os.showWaitingBubble(senderId);
  }
  // Always show the speech bubble — even if we couldn't walk, we want the
  // viewer to see who said what.
  setSpeech(senderId, msg.text);

  // Pin the agent at the destination: while in CharacterState.IDLE the engine
  // counts down `wanderTimer` (2–20s) and then walks them to a random tile.
  // We override the timer every tick so they stay still during the encounter.
  // Also reset wanderCount so the auto "return to seat" logic doesn't fire.
  const pinHandle = window.setInterval(() => {
    const ch = os.characters.get(senderId);
    if (ch) {
      ch.wanderTimer = 9999;
      ch.wanderCount = 0;
    }
  }, 250);

  window.setTimeout(() => {
    window.clearInterval(pinHandle);
    onDone();
  }, ENCOUNTER_LINGER_MS);
}

const ADJ_OFFSETS: Array<[number, number]> = [
  [0, 1], [0, -1], [1, 0], [-1, 0],
  [1, 1], [-1, -1], [1, -1], [-1, 1],
];

/** Pick the walkable neighbor of the receiver closest to the sender's
 * current tile, so the sender ends up on the natural side. */
function pickAdjacentWalkable(
  os: OfficeState,
  receiverCol: number,
  receiverRow: number,
  fromCol: number,
  fromRow: number,
): { col: number; row: number } | null {
  const walkSet = new Set(os.walkableTiles.map((t) => `${t.col},${t.row}`));
  let best: { col: number; row: number; dist: number } | null = null;
  for (const [dc, dr] of ADJ_OFFSETS) {
    const c = receiverCol + dc;
    const r = receiverRow + dr;
    if (!walkSet.has(`${c},${r}`)) continue;
    const dist = Math.abs(c - fromCol) + Math.abs(r - fromRow);
    if (!best || dist < best.dist) best = { col: c, row: r, dist };
  }
  return best ? { col: best.col, row: best.row } : null;
}

// ── Message Log Item ───────────────────────────────────────────────────────

interface LogMessage {
  id: string;
  from: string;
  to: string;
  content: string;
  timestamp: string;
}

// ── Gate screen ────────────────────────────────────────────────────────────

type GatePhase = 'checking' | 'required' | 'passed';

interface GateScreenProps {
  phase: GatePhase;
  onPassed: () => void;
}

function GateScreen({ phase, onPassed }: GateScreenProps) {
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = token.trim();
    if (!trimmed) {
      setError('Pegá el access token.');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await verifyGateToken(trimmed);
      setStoredGateToken(trimmed);
      setToken('');
      onPassed();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Token inválido');
    } finally {
      setSubmitting(false);
    }
  }

  // Pixel/Minecraft-inspired gate: full-screen centered, dark gradient sky,
  // chunky retro fonts (Press Start 2P for the title, Pixelify Sans for body),
  // animated glow on the card and the button.
  const PIXEL_TITLE = "'Press Start 2P', 'Pixelify Sans', monospace";
  const PIXEL_BODY = "'Pixelify Sans', 'Press Start 2P', monospace";

  const wrapper: CSSProperties = {
    width: '100vw',
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background:
      'radial-gradient(ellipse at top, #1a1a3a 0%, #0a0a18 50%, #050510 100%)',
    color: '#e2e8f0',
    fontFamily: PIXEL_BODY,
    padding: '2rem',
    boxSizing: 'border-box',
  };

  const card: CSSProperties = {
    width: '100%',
    maxWidth: '480px',
    background: 'linear-gradient(180deg, #14142e 0%, #0e0e22 100%)',
    border: '2px solid #6366f1',
    borderRadius: '4px',
    padding: '2.5rem 2rem 2rem',
    boxShadow:
      '0 0 0 4px #0a0a18, 0 0 32px rgba(99, 102, 241, 0.4), inset 0 0 24px rgba(99, 102, 241, 0.08)',
    textAlign: 'center',
  };

  const titleStyle: CSSProperties = {
    fontFamily: PIXEL_TITLE,
    fontSize: '1.4rem',
    color: '#a5b4fc',
    margin: '0 0 0.4rem',
    letterSpacing: '1px',
    textShadow:
      '0 0 8px rgba(99, 102, 241, 0.7), 2px 2px 0 #0a0a18, 4px 4px 0 rgba(99, 102, 241, 0.2)',
    lineHeight: 1.3,
  };

  const subtitleStyle: CSSProperties = {
    fontFamily: PIXEL_BODY,
    fontSize: '1rem',
    color: '#94a3b8',
    margin: '0 0 1.75rem',
    letterSpacing: '0.5px',
  };

  const sectionTitleStyle: CSSProperties = {
    fontFamily: PIXEL_TITLE,
    fontSize: '0.7rem',
    color: '#fbbf24',
    margin: '0 0 0.75rem',
    letterSpacing: '1px',
    textShadow: '0 0 6px rgba(251, 191, 36, 0.5), 2px 2px 0 #0a0a18',
  };

  const sectionDescStyle: CSSProperties = {
    fontFamily: PIXEL_BODY,
    fontSize: '0.95rem',
    color: '#cbd5e1',
    margin: '0 0 1.5rem',
    lineHeight: 1.5,
  };

  const labelStyle: CSSProperties = {
    display: 'block',
    fontFamily: PIXEL_TITLE,
    fontSize: '0.55rem',
    color: '#a5b4fc',
    marginBottom: '0.5rem',
    letterSpacing: '1.5px',
    textAlign: 'left',
  };

  const inputStyle: CSSProperties = {
    fontFamily: PIXEL_BODY,
    fontSize: '1.05rem',
    background: '#06061a',
    color: '#e2e8f0',
    border: '2px solid #2d2d5a',
    borderRadius: '4px',
    padding: '0.75rem 0.9rem',
    width: '100%',
    boxSizing: 'border-box',
    outline: 'none',
    letterSpacing: '0.5px',
    boxShadow: 'inset 0 0 8px rgba(0, 0, 0, 0.5)',
  };

  const buttonStyle: CSSProperties = {
    fontFamily: PIXEL_TITLE,
    fontSize: '0.7rem',
    background: submitting
      ? 'linear-gradient(180deg, #4338ca, #3730a3)'
      : 'linear-gradient(180deg, #6366f1, #4f46e5)',
    color: '#fff',
    border: '2px solid #818cf8',
    borderRadius: '4px',
    padding: '0.85rem 1.5rem',
    width: '100%',
    cursor: submitting ? 'wait' : 'pointer',
    letterSpacing: '2px',
    textShadow: '2px 2px 0 #1e1b4b',
    boxShadow:
      '0 4px 0 #312e81, 0 0 16px rgba(99, 102, 241, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.1)',
    transition: 'transform 0.05s, box-shadow 0.05s',
  };

  if (phase === 'checking') {
    return (
      <div style={wrapper}>
        <div style={card}>
          <h1 style={titleStyle}>bridge-agentesIA</h1>
          <p style={subtitleStyle}>Verificando acceso…</p>
        </div>
      </div>
    );
  }

  return (
    <div style={wrapper}>
      <form onSubmit={handleSubmit} style={card}>
        <h1 style={titleStyle}>bridge-agentesIA</h1>
        <p style={subtitleStyle}>Cola de mensajes inter-agente</p>

        <h2 style={sectionTitleStyle}>◆ Acceso restringido ◆</h2>
        <p style={sectionDescStyle}>
          Esta plataforma requiere un token de acceso.<br />
          Pedíselo al administrador.
        </p>

        {error && (
          <div style={{
            fontFamily: PIXEL_BODY,
            background: '#3a0f17',
            border: '2px solid #ef4444',
            color: '#fecaca',
            padding: '0.6rem 0.8rem',
            borderRadius: '4px',
            fontSize: '0.95rem',
            marginBottom: '1rem',
            textAlign: 'left',
          }}>
            ⚠ {error}
          </div>
        )}

        <div style={{ marginBottom: '1.5rem' }}>
          <label style={labelStyle}>Access token</label>
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="paste your access token"
            autoComplete="off"
            autoFocus
            style={inputStyle}
          />
        </div>

        <button
          type="submit"
          disabled={submitting}
          style={buttonStyle}
          onMouseDown={(e) => {
            if (submitting) return;
            e.currentTarget.style.transform = 'translateY(2px)';
            e.currentTarget.style.boxShadow =
              '0 2px 0 #312e81, 0 0 16px rgba(99, 102, 241, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.1)';
          }}
          onMouseUp={(e) => {
            e.currentTarget.style.transform = '';
            e.currentTarget.style.boxShadow = buttonStyle.boxShadow as string;
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.transform = '';
            e.currentTarget.style.boxShadow = buttonStyle.boxShadow as string;
          }}
        >
          {submitting ? 'Verificando…' : '▶ Entrar'}
        </button>
      </form>
    </div>
  );
}

// ── App ────────────────────────────────────────────────────────────────────

function App() {
  const [layoutReady, setLayoutReady] = useState(false);
  const [messages, setMessages] = useState<LogMessage[]>([]);
  const [agentEntries, setAgentEntries] = useState<AgentEntry[]>([]);
  const [agentSpeech, setAgentSpeech] = useState<Record<number, string>>({});
  const containerRef = useRef<HTMLDivElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const [feedStatus, setFeedStatus] = useState<'connecting' | 'open' | 'closed'>('connecting');
  const [gatePhase, setGatePhase] = useState<GatePhase>('checking');
  // Sidebar groups are collapsed by default; clicking a sender's name toggles
  // their messages open. Tracked as a set of expanded agent ids.
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set());
  const [expandedMessages, setExpandedMessages] = useState<Set<string>>(() => new Set());

  const toggleGroup = useCallback((agentId: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(agentId)) next.delete(agentId);
      else next.add(agentId);
      return next;
    });
  }, []);

  // Editor (visual layout designer). isEditMode toggles via header button.
  const editorStateRef = useRef<EditorState | null>(null);
  if (editorStateRef.current === null) editorStateRef.current = new EditorState();
  const editor = useEditorActions(getOfficeState, editorStateRef.current);
  const { zoom, panRef } = editor;
  const setZoom = editor.handleZoomChange;

  // Gate check: mirrors the original /v1/dashboard flow. If the bridge has
  // REGISTRATION_TOKEN set, ask for the access token *before* connecting to
  // /v1/office/feed so the user never sees a 401 mid-load.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const status = await fetchGateStatus();
      if (cancelled) return;
      if (!status.required) { setGatePhase('passed'); return; }
      const stored = getStoredGateToken();
      if (stored) {
        try {
          await verifyGateToken(stored);
          if (!cancelled) setGatePhase('passed');
          return;
        } catch {
          clearStoredGateToken();
        }
      }
      if (!cancelled) setGatePhase('required');
    })();
    return () => { cancelled = true; };
  }, []);

  // Load assets and init Bridge connection (gated: only runs once gatePhase==='passed')
  useEffect(() => {
    if (gatePhase !== 'passed') return;
    let cancelled = false;

    async function init() {
      // Step 1: Load pixel art assets
      await loadAssets();
      if (cancelled) return;

      // Step 2: Set up message listener BEFORE dispatching
      const handler = (e: MessageEvent) => {
        const msg = e.data;
        const os = getOfficeState();

        if (msg.type === 'characterSpritesLoaded') {
          setCharacterTemplates(msg.characters);
        } else if (msg.type === 'floorTilesLoaded') {
          setFloorSprites(msg.sprites);
        } else if (msg.type === 'wallTilesLoaded') {
          setWallSprites(msg.sets);
        } else if (msg.type === 'furnitureAssetsLoaded') {
          buildDynamicCatalog({ catalog: msg.catalog, sprites: msg.sprites });
        } else if (msg.type === 'layoutLoaded') {
          // Prefer a locally saved draft from previous editor session if available.
          const draft = getDraftLayout() as OfficeLayout | null;
          const rawLayout = (draft && draft.version === 1 ? draft : msg.layout) as OfficeLayout | null;
          const layout = rawLayout && rawLayout.version === 1 ? migrateLayoutColors(rawLayout) : null;
          if (layout) {
            os.rebuildFromLayout(layout);
            editor.setLastSavedLayout(layout);
          }
          setLayoutReady(true);
        } else if (msg.type === 'agentCreated') {
          const id = msg.id as number;
          if (!os.characters.has(id)) {
            os.addAgent(id, msg.palette as number | undefined, msg.hueShift as number | undefined);
          }
        } else if (msg.type === 'agentAppearanceChanged') {
          // Self-service appearance update from PATCH /v1/me/appearance: hot-swap
          // the character's palette/hueShift so the renderer retints next frame.
          const id = msg.id as number;
          const ch = os.characters.get(id);
          if (ch) {
            if (typeof msg.palette === 'number') ch.palette = msg.palette;
            if (typeof msg.hueShift === 'number') ch.hueShift = msg.hueShift;
          }
        }
      };

      window.addEventListener('message', handler);

      // Step 3: Dispatch asset messages
      dispatchAssetMessages();

      // Step 4: Build dynamic agent registry from /v1/agents
      await syncAgents();

      // Step 5: Prime the message log with persisted history (Railway volume)
      // before opening the SSE stream so users see prior conversations on
      // first load, not just messages that arrive after they connect.
      const history = await loadHistory(200);
      if (cancelled) return;
      if (history.length) {
        setMessages(history.map((m) => ({
          id: m.id,
          from: m.from,
          to: m.to,
          content: m.message,
          timestamp: m.created_at,
        })));
      }

      // Step 6: Subscribe to SSE feed for live messages
      startFeed();
    }

    init();
    return () => { cancelled = true; stopFeed(); };
  }, [gatePhase]);

  // Track agent registry changes (header dots, log labels)
  useEffect(() => {
    return onAgentsChanged((entries) => setAgentEntries(entries));
  }, []);

  // Track feed connection status
  useEffect(() => {
    return onFeedStatus((s) => setFeedStatus(s));
  }, []);

  // Listen for new Bridge messages
  useEffect(() => {
    const setSpeech: SetSpeech = (id, text) => {
      setAgentSpeech((prev) => {
        if (text === null) {
          if (!(id in prev)) return prev;
          const { [id]: _gone, ...rest } = prev;
          return rest;
        }
        return { ...prev, [id]: text };
      });
    };

    const unsub = onNewMessages((newMsgs: LiveMessage[]) => {
      const os = getOfficeState();

      for (const msg of newMsgs) {
        // Append to log; dedupe against history that may share ids with the
        // first SSE batch on reconnect.
        setMessages((prev) => {
          if (prev.some((m) => m.id === msg.id)) return prev;
          const next = [...prev, {
            id: msg.id,
            from: msg.from,
            to: msg.to,
            content: msg.message,
            timestamp: msg.created_at,
          }];
          // Keep memory bounded but allow more than the live window since
          // we now also load history.
          return next.length > 500 ? next.slice(next.length - 500) : next;
        });

        enqueueEncounter(os, msg.from, msg.to, msg.message, setSpeech);
      }
    });
    return unsub;
  }, []);

  // When a new message arrives, scroll the sidebar back to the top so the
  // group with the most recent activity (which has just floated up) is in view.
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = 0;
  }, [messages]);

  const handleClick = useCallback((_agentId: number) => {
    // Future: center camera on agent, show details
  }, []);

  const handleDownloadLayout = useCallback(() => {
    const layout = getOfficeState().getLayout();
    const blob = new Blob([JSON.stringify(layout, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'office-layout.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, []);

  const handleExpand = useCallback((direction: ExpandDirection) => {
    const os = getOfficeState();
    const result = expandLayout(os.getLayout(), direction);
    if (!result) return;
    os.rebuildFromLayout(result.layout);
    if (editorStateRef.current) editorStateRef.current.isDirty = true;
    // Persist via the same path as a tile edit so localStorage tracks the new size.
    editor.handleEditorSelectionChange();
    // Trigger a save by simulating a no-op edit through the hook's debounced path.
    editor.handleSave();
  }, [editor]);

  const handleResetLayout = useCallback(() => {
    if (!confirm('¿Descartar tus cambios y volver al layout original del repo?')) return;
    clearDraftLayout();
    location.reload();
  }, []);

  // Set of currently-registered agent ids — used to filter out orphan senders
  // (revoked agents, old test data) so the sidebar only shows agents that are
  // also present on the office canvas.
  const knownAgentIds = useMemo(
    () => new Set(agentEntries.map((a) => a.agentId)),
    [agentEntries],
  );

  // Group messages by sender agent for the sidebar. Each group's messages are
  // sorted oldest-first; groups themselves are ordered by most recent activity
  // (so the agent who just spoke floats to the top).
  // NOTE: must live above the early returns below to keep hook order stable.
  const messageGroups = useMemo(() => {
    const byAgent = new Map<string, LogMessage[]>();
    for (const m of messages) {
      if (!knownAgentIds.has(m.from)) continue;
      const list = byAgent.get(m.from) ?? [];
      list.push(m);
      byAgent.set(m.from, list);
    }
    const groups = Array.from(byAgent.entries()).map(([agentId, msgs]) => {
      // Newest first inside each group so the latest message sits at the top
      // when expanded (matches the parent ordering, no scroll needed to read).
      msgs.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
      const lastTs = msgs[0]?.timestamp ?? '';
      return { agentId, messages: msgs, lastTs };
    });
    groups.sort((a, b) => b.lastTs.localeCompare(a.lastTs));
    return groups;
  }, [messages, knownAgentIds]);

  const editorBtnStyle: CSSProperties = {
    background: '#1e1e3a',
    border: '1px solid #2a2a4a',
    color: '#e5e7eb',
    fontSize: '12px',
    width: '26px',
    height: '26px',
    borderRadius: '4px',
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
  };

  if (gatePhase !== 'passed') {
    return (
      <GateScreen
        phase={gatePhase}
        onPassed={() => setGatePhase('passed')}
      />
    );
  }

  if (!layoutReady) {
    return (
      <div style={{
        width: '100vw',
        height: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#0a0a0f',
        color: '#6366f1',
        fontFamily: "'Press Start 2P', monospace",
        fontSize: '14px',
      }}>
        Loading URPE AI Lab...
      </div>
    );
  }

  const visibleAgents = agentEntries.slice(0, 8); // header gets crowded past this
  const characterIds = agentEntries.map((a) => a.characterId);
  const agentNamesById: Record<number, string> = {};
  for (const a of agentEntries) agentNamesById[a.characterId] = a.displayName;
  const bridgeOnline = feedStatus === 'open';

  return (
    <div style={{ width: '100vw', height: '100vh', display: 'flex', flexDirection: 'column', background: '#0a0a0f', overflow: 'hidden' }}>

      {/* Header */}
      <header style={{
        height: '48px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 20px',
        background: 'linear-gradient(135deg, #0f0f1a 0%, #1a1a2e 100%)',
        borderBottom: '2px solid #1e1e3a',
        flexShrink: 0,
        zIndex: 50,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <span style={{ fontSize: '18px' }}>🎮</span>
          <span style={{
            fontFamily: "'Inter', sans-serif",
            fontWeight: 700,
            fontSize: '15px',
            background: 'linear-gradient(135deg, #6366f1, #a855f7)',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
            letterSpacing: '1px',
          }}>
            URPE AI LAB
          </span>
          <span style={{
            fontSize: '10px',
            color: '#4b5563',
            fontFamily: "'Inter', sans-serif",
          }}>
            PIXEL OFFICE
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          {/* Edit-mode toggle */}
          <button
            type="button"
            onClick={editor.handleToggleEditMode}
            title={editor.isEditMode ? 'Salir del modo edición' : 'Editar oficina'}
            style={{
              background: editor.isEditMode ? '#6366f1' : 'transparent',
              border: '1px solid #1e1e3a',
              color: editor.isEditMode ? '#fff' : '#9ca3af',
              fontFamily: "'Inter', sans-serif",
              fontSize: '11px',
              padding: '4px 10px',
              borderRadius: '6px',
              cursor: 'pointer',
            }}
          >
            ✏️ {editor.isEditMode ? 'Editando' : 'Editar'}
          </button>
          {editor.isEditMode && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              <button type="button" onClick={() => handleExpand('up')} title="Expandir arriba" style={editorBtnStyle}>⬆</button>
              <button type="button" onClick={() => handleExpand('down')} title="Expandir abajo" style={editorBtnStyle}>⬇</button>
              <button type="button" onClick={() => handleExpand('left')} title="Expandir izquierda" style={editorBtnStyle}>⬅</button>
              <button type="button" onClick={() => handleExpand('right')} title="Expandir derecha" style={editorBtnStyle}>➡</button>
              <button type="button" onClick={editor.handleUndo} title="Deshacer" style={editorBtnStyle}>↶</button>
              <button type="button" onClick={editor.handleRedo} title="Rehacer" style={editorBtnStyle}>↷</button>
              <button type="button" onClick={handleResetLayout} title="Descartar cambios y recargar" style={editorBtnStyle}>⤴</button>
              <button type="button" onClick={handleDownloadLayout} title="Descargar JSON del layout" style={{ ...editorBtnStyle, background: '#22c55e22', color: '#86efac' }}>💾</button>
            </div>
          )}
          {/* Agent status dots */}
          {visibleAgents.map((agent) => (
            <div key={agent.agentId} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <div style={{
                width: '8px',
                height: '8px',
                borderRadius: '50%',
                background: agent.color,
                boxShadow: `0 0 6px ${agent.color}80`,
              }} />
              <span style={{ fontSize: '11px', color: '#9ca3af', fontFamily: "'Inter', sans-serif" }}>
                {agent.displayName}
              </span>
            </div>
          ))}
          {agentEntries.length > visibleAgents.length && (
            <span style={{ fontSize: '11px', color: '#6b7280', fontFamily: "'Inter', sans-serif" }}>
              +{agentEntries.length - visibleAgents.length}
            </span>
          )}
          <div title={`feed: ${feedStatus}`} style={{
            width: '6px',
            height: '6px',
            borderRadius: '50%',
            background: bridgeOnline ? '#22c55e' : '#ef4444',
            marginLeft: '8px',
          }} />
        </div>
      </header>

      {/* Main content */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>

        {/* Office canvas */}
        <div ref={containerRef} style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
          <OfficeCanvas
            officeState={getOfficeState()}
            onClick={handleClick}
            isEditMode={editor.isEditMode}
            editorState={editorStateRef.current!}
            onEditorTileAction={editor.handleEditorTileAction}
            onEditorEraseAction={editor.handleEditorEraseAction}
            onEditorSelectionChange={editor.handleEditorSelectionChange}
            onDeleteSelected={editor.handleDeleteSelected}
            onRotateSelected={editor.handleRotateSelected}
            onDragMove={editor.handleDragMove}
            editorTick={editor.editorTick}
            zoom={zoom}
            onZoomChange={setZoom}
            panRef={panRef}
          />
          <ToolOverlay
            officeState={getOfficeState()}
            agents={characterIds}
            agentTools={{}}
            subagentCharacters={[]}
            containerRef={containerRef}
            zoom={zoom}
            panRef={panRef}
            onCloseAgent={() => {}}
            alwaysShowOverlay={true}
            agentNames={agentNamesById}
            agentSpeech={agentSpeech}
          />
          <ZoomControls zoom={zoom} onZoomChange={setZoom} />
          {/* Vignette */}
          <div style={{
            position: 'absolute',
            inset: 0,
            pointerEvents: 'none',
            background: 'radial-gradient(ellipse at center, transparent 60%, rgba(0,0,0,0.4) 100%)',
          }} />
          {editor.isEditMode && (
            <EditorToolbar
              activeTool={editorStateRef.current!.activeTool}
              selectedTileType={editorStateRef.current!.selectedTileType}
              selectedFurnitureType={editorStateRef.current!.selectedFurnitureType}
              selectedFurnitureUid={editorStateRef.current!.selectedFurnitureUid}
              selectedFurnitureColor={editorStateRef.current!.pickedFurnitureColor}
              floorColor={editorStateRef.current!.floorColor}
              wallColor={editorStateRef.current!.wallColor}
              selectedWallSet={editorStateRef.current!.selectedWallSet}
              onToolChange={editor.handleToolChange}
              onTileTypeChange={editor.handleTileTypeChange}
              onFloorColorChange={editor.handleFloorColorChange}
              onWallColorChange={editor.handleWallColorChange}
              onWallSetChange={editor.handleWallSetChange}
              onSelectedFurnitureColorChange={editor.handleSelectedFurnitureColorChange}
              onFurnitureTypeChange={editor.handleFurnitureTypeChange}
            />
          )}
        </div>

        {/* Message Log Panel */}
        <aside style={{
          width: '320px',
          background: '#0f0f1a',
          borderLeft: '2px solid #1e1e3a',
          display: 'flex',
          flexDirection: 'column',
          flexShrink: 0,
        }}>
          <div style={{
            padding: '14px 16px',
            borderBottom: '1px solid #1e1e3a',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
          }}>
            <span style={{ fontSize: '14px' }}>💬</span>
            <span style={{
              fontFamily: "'Inter', sans-serif",
              fontWeight: 600,
              fontSize: '13px',
              color: '#d1d5db',
            }}>
              Bridge Messages
            </span>
            <span style={{
              fontSize: '10px',
              color: '#6b7280',
              marginLeft: 'auto',
              fontFamily: "'Inter', sans-serif",
            }}>
              {messageGroups.reduce((acc, g) => acc + g.messages.length, 0)}
            </span>
          </div>

          <div ref={logRef} style={{
            flex: 1,
            overflowY: 'auto',
            padding: '8px',
          }}>
            {messageGroups.length === 0 ? (
              <div style={{
                textAlign: 'center',
                padding: '40px 16px',
                color: '#4b5563',
                fontSize: '12px',
                fontFamily: "'Inter', sans-serif",
              }}>
                {feedStatus === 'open'
                  ? 'Waiting for messages...'
                  : feedStatus === 'connecting'
                    ? 'Connecting to bridge...'
                    : 'Disconnected — retrying'}
              </div>
            ) : (
              messageGroups.map((group) => {
                const fromEntry = getAgentEntry(group.agentId);
                const groupColor = fromEntry?.color || '#6b7280';
                const isOpen = expandedGroups.has(group.agentId);
                const lastTime = new Date(group.lastTs);
                const lastTimeStr = isNaN(lastTime.getTime())
                  ? ''
                  : lastTime.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
                return (
                  <div key={group.agentId} style={{ marginBottom: '6px' }}>
                    {/* Clickable group header — toggles the message list */}
                    <button
                      type="button"
                      onClick={() => toggleGroup(group.agentId)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '10px',
                        width: '100%',
                        padding: '12px 12px',
                        background: '#14142a',
                        border: `1px solid ${groupColor}33`,
                        borderLeft: `4px solid ${groupColor}`,
                        borderRadius: isOpen ? '6px 6px 0 0' : '6px',
                        cursor: 'pointer',
                        textAlign: 'left',
                      }}
                    >
                      <span style={{
                        fontSize: '16px',
                        color: groupColor,
                        width: '14px',
                        display: 'inline-block',
                        transition: 'transform 0.15s',
                        transform: isOpen ? 'rotate(90deg)' : 'rotate(0deg)',
                        flexShrink: 0,
                      }}>▶</span>
                      <div style={{
                        width: '10px',
                        height: '10px',
                        borderRadius: '50%',
                        background: groupColor,
                        boxShadow: `0 0 6px ${groupColor}80`,
                        flexShrink: 0,
                      }} />
                      <span style={{
                        fontSize: '16px',
                        fontWeight: 700,
                        color: groupColor,
                      }}>
                        {getAgentDisplayName(group.agentId)}
                      </span>
                      <span style={{
                        fontSize: '16px',
                        color: '#6b7280',
                        marginLeft: 'auto',
                      }}>
                        {lastTimeStr}
                      </span>
                      <span style={{
                        fontSize: '16px',
                        fontWeight: 600,
                        color: '#e5e7eb',
                        background: '#1e1e3a',
                        padding: '2px 10px',
                        borderRadius: '10px',
                        minWidth: '28px',
                        textAlign: 'center',
                      }}>
                        {group.messages.length}
                      </span>
                    </button>

                    {/* Messages list — only rendered when the group is open */}
                    {isOpen && (
                      <div style={{
                        borderLeft: `1px solid ${groupColor}33`,
                        borderRight: `1px solid ${groupColor}33`,
                        borderBottom: `1px solid ${groupColor}33`,
                        borderRadius: '0 0 6px 6px',
                        padding: '4px',
                        background: '#0c0c18',
                      }}>
                        {group.messages.map((msg) => {
                          const toEntry = getAgentEntry(msg.to);
                          const time = new Date(msg.timestamp);
                          const timeStr = isNaN(time.getTime())
                            ? msg.timestamp
                            : time.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
                          return (
                            <div key={msg.id} style={{
                              padding: '8px 10px',
                              marginBottom: '3px',
                              borderRadius: '4px',
                              background: '#14142a',
                            }}>
                              <div style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: '6px',
                                marginBottom: '3px',
                              }}>
                                <span style={{ fontSize: '10px', color: '#4b5563', fontFamily: "'Inter', sans-serif" }}>→</span>
                                <span style={{
                                  fontSize: '11px',
                                  color: toEntry?.color || '#9ca3af',
                                  fontFamily: "'Inter', sans-serif",
                                }}>
                                  {getAgentDisplayName(msg.to)}
                                </span>
                                <span style={{
                                  fontSize: '9px',
                                  color: '#4b5563',
                                  marginLeft: 'auto',
                                  fontFamily: "'Inter', sans-serif",
                                }}>
                                  {timeStr}
                                </span>
                              </div>
                              <p style={{
                                fontSize: '11px',
                                color: '#9ca3af',
                                margin: 0,
                                lineHeight: 1.4,
                                fontFamily: "'Inter', sans-serif",
                                ...(expandedMessages.has(msg.id) ? {} : {
                                  overflow: 'hidden',
                                  display: '-webkit-box',
                                  WebkitLineClamp: 3,
                                  WebkitBoxOrient: 'vertical' as const,
                                }),
                              }}>
                                {msg.content}
                              </p>
                              {msg.content.length > 120 && (
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setExpandedMessages((prev) => {
                                      const next = new Set(prev);
                                      if (next.has(msg.id)) next.delete(msg.id);
                                      else next.add(msg.id);
                                      return next;
                                    });
                                  }}
                                  style={{
                                    background: 'none',
                                    border: 'none',
                                    color: '#6366f1',
                                    fontSize: '10px',
                                    padding: '2px 0 0 0',
                                    cursor: 'pointer',
                                    fontFamily: "'Inter', sans-serif",
                                  }}
                                >
                                  {expandedMessages.has(msg.id) ? 'ver menos' : 'ver más'}
                                </button>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

export default App;
