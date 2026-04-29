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

  // Visual parity with the original dashboard gate (`/`): same monospace,
  // GitHub-dark palette, uppercase label, blue primary button.
  const wrapper: CSSProperties = {
    width: '100vw',
    minHeight: '100vh',
    background: '#0d1117',
    color: '#c9d1d9',
    fontFamily: 'monospace',
    padding: '2rem',
    boxSizing: 'border-box',
  };
  const inner: CSSProperties = {
    maxWidth: '1100px',
    margin: '0 auto',
  };
  const card: CSSProperties = {
    background: '#161b22',
    border: '1px solid #30363d',
    borderRadius: '8px',
    padding: '1.25rem',
    maxWidth: '640px',
  };
  const heading: CSSProperties = {
    color: '#e6edf3',
    fontSize: '1rem',
    margin: '0 0 0.8rem',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    borderBottom: '1px solid #21262d',
    paddingBottom: '0.4rem',
    fontWeight: 600,
  };
  const labelStyle: CSSProperties = {
    display: 'block',
    fontSize: '0.75rem',
    color: '#8b949e',
    marginBottom: '0.3rem',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  };
  const inputStyle: CSSProperties = {
    fontFamily: 'monospace',
    background: '#0d1117',
    color: '#c9d1d9',
    border: '1px solid #30363d',
    borderRadius: '6px',
    padding: '0.5rem 0.75rem',
    fontSize: '0.85rem',
    width: '100%',
    boxSizing: 'border-box',
  };
  const buttonStyle: CSSProperties = {
    fontFamily: 'monospace',
    background: submitting ? '#1747a8' : '#1f6feb',
    color: '#fff',
    border: '1px solid #1f6feb',
    borderRadius: '6px',
    padding: '0.5rem 1rem',
    fontSize: '0.85rem',
    cursor: submitting ? 'wait' : 'pointer',
  };

  if (phase === 'checking') {
    return (
      <div style={wrapper}>
        <div style={inner}>
          <h1 style={{ fontSize: '1.5rem', color: '#58a6ff', margin: '0 0 0.5rem' }}>bridge-agentesIA</h1>
          <p style={{ color: '#8b949e', margin: '0 0 1.5rem' }}>Cola de mensajes inter-agente</p>
          <div style={card}>Verificando acceso…</div>
        </div>
      </div>
    );
  }

  return (
    <div style={wrapper}>
      <div style={inner}>
        <h1 style={{ fontSize: '1.5rem', color: '#58a6ff', margin: '0 0 0.5rem' }}>bridge-agentesIA</h1>
        <p style={{ color: '#8b949e', margin: '0 0 1.5rem' }}>Cola de mensajes inter-agente</p>
        <form onSubmit={handleSubmit} style={card}>
          <h2 style={heading}>Acceso restringido</h2>
          <p style={{ color: '#8b949e', fontSize: '0.85rem', marginBottom: '1rem' }}>
            Esta plataforma requiere un token de acceso. Pedíselo al administrador.
          </p>
          {error && (
            <div style={{
              background: '#3a0f17',
              border: '1px solid #7f1d1d',
              color: '#fecaca',
              padding: '0.5rem 0.75rem',
              borderRadius: '6px',
              fontSize: '0.85rem',
              marginBottom: '0.75rem',
            }}>
              {error}
            </div>
          )}
          <div style={{ marginBottom: '1rem' }}>
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
          <button type="submit" disabled={submitting} style={buttonStyle}>
            {submitting ? 'Verificando…' : 'Entrar'}
          </button>
        </form>
      </div>
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

  // Group messages by sender agent for the sidebar. Each group's messages are
  // sorted oldest-first; groups themselves are ordered by most recent activity
  // (so the agent who just spoke floats to the top).
  const messageGroups = useMemo(() => {
    const byAgent = new Map<string, LogMessage[]>();
    for (const m of messages) {
      const list = byAgent.get(m.from) ?? [];
      list.push(m);
      byAgent.set(m.from, list);
    }
    const groups = Array.from(byAgent.entries()).map(([agentId, msgs]) => {
      msgs.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      const lastTs = msgs[msgs.length - 1]?.timestamp ?? '';
      return { agentId, messages: msgs, lastTs };
    });
    groups.sort((a, b) => b.lastTs.localeCompare(a.lastTs));
    return groups;
  }, [messages]);

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
              {messages.length}
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
                return (
                  <div key={group.agentId} style={{ marginBottom: '12px' }}>
                    {/* Group header — sender agent */}
                    <div style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      padding: '6px 10px',
                      background: '#14142a',
                      border: `1px solid ${groupColor}33`,
                      borderLeft: `3px solid ${groupColor}`,
                      borderRadius: '6px 6px 0 0',
                      position: 'sticky',
                      top: 0,
                      zIndex: 1,
                    }}>
                      <div style={{
                        width: '8px',
                        height: '8px',
                        borderRadius: '50%',
                        background: groupColor,
                        boxShadow: `0 0 6px ${groupColor}80`,
                        flexShrink: 0,
                      }} />
                      <span style={{
                        fontSize: '12px',
                        fontWeight: 700,
                        color: groupColor,
                        fontFamily: "'Inter', sans-serif",
                      }}>
                        {getAgentDisplayName(group.agentId)}
                      </span>
                      <span style={{
                        fontSize: '10px',
                        color: '#6b7280',
                        marginLeft: 'auto',
                        fontFamily: "'Inter', sans-serif",
                      }}>
                        {group.messages.length}
                      </span>
                    </div>

                    {/* Messages from this sender */}
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
                              overflow: 'hidden',
                              display: '-webkit-box',
                              WebkitLineClamp: 3,
                              WebkitBoxOrient: 'vertical',
                            }}>
                              {msg.content}
                            </p>
                          </div>
                        );
                      })}
                    </div>
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
