import { useCallback, useEffect, useRef, useState } from 'react';

import {
  loadAssets,
  dispatchAssetMessages,
  dispatchAgentMessages,
  startPolling,
  stopPolling,
  onNewMessages,
  getCharacterId,
  getAgentDisplayName,
  AGENT_CONFIGS,
  type AgentConfig,
} from './bridgeAdapter.ts';
import { fetchAgents, type BridgeMessage } from './bridgeClient.ts';
import { OfficeCanvas } from './office/components/OfficeCanvas.js';
import { ToolOverlay } from './office/components/ToolOverlay.js';
import { OfficeState } from './office/engine/officeState.js';
import { setFloorSprites } from './office/floorTiles.js';
import { buildDynamicCatalog } from './office/layout/furnitureCatalog.js';
import { migrateLayoutColors } from './office/layout/layoutSerializer.js';
import { setCharacterTemplates } from './office/sprites/spriteData.js';
import type { OfficeLayout } from './office/types.js';
import { setWallSprites } from './office/wallTiles.js';
import { ZoomControls } from './components/ZoomControls.js';

// ── Game state (outside React) ─────────────────────────────────────────────

const officeStateRef = { current: null as OfficeState | null };

function getOfficeState(): OfficeState {
  if (!officeStateRef.current) {
    officeStateRef.current = new OfficeState();
  }
  return officeStateRef.current;
}

// ── Message Log Item ───────────────────────────────────────────────────────

interface LogMessage {
  id: string;
  from: string;
  to: string;
  content: string;
  timestamp: string;
}

// ── App ────────────────────────────────────────────────────────────────────

function App() {
  const [layoutReady, setLayoutReady] = useState(false);
  const [zoom, setZoom] = useState(2);
  const [messages, setMessages] = useState<LogMessage[]>([]);
  const [agents] = useState<number[]>(() => AGENT_CONFIGS.map((_, i) => i + 1));
  const panRef = useRef({ x: 0, y: 0 });
  const containerRef = useRef<HTMLDivElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const [bridgeOnline, setBridgeOnline] = useState(false);

  // Load assets and init Bridge connection
  useEffect(() => {
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
          const rawLayout = msg.layout as OfficeLayout | null;
          const layout = rawLayout && rawLayout.version === 1 ? migrateLayoutColors(rawLayout) : null;
          if (layout) {
            os.rebuildFromLayout(layout);
          }
          setLayoutReady(true);
        } else if (msg.type === 'agentCreated') {
          const id = msg.id as number;
          if (!os.characters.has(id)) {
            os.addAgent(id);
          }
        }
      };

      window.addEventListener('message', handler);

      // Step 3: Dispatch asset messages
      dispatchAssetMessages();

      // Step 4: Fetch bridge agents and create characters
      const bridgeAgents = await fetchAgents();
      if (bridgeAgents.length > 0) {
        setBridgeOnline(true);
        dispatchAgentMessages(bridgeAgents);
      }

      // Step 5: Start polling for messages
      startPolling(5000);
    }

    init();
    return () => { cancelled = true; stopPolling(); };
  }, []);

  // Listen for new Bridge messages
  useEffect(() => {
    const unsub = onNewMessages((newMsgs: BridgeMessage[]) => {
      const os = getOfficeState();

      for (const msg of newMsgs) {
        // Add to log
        setMessages((prev) => [
          ...prev.slice(-99), // keep last 100
          {
            id: msg.message_id,
            from: msg.from_agent,
            to: msg.to_agent,
            content: msg.content,
            timestamp: msg.timestamp,
          },
        ]);

        // Animate sender agent
        const senderId = getCharacterId(msg.from_agent);
        if (senderId !== null) {
          os.setAgentActive(senderId, true);
          os.showWaitingBubble(senderId);
          // Deactivate after 8 seconds
          setTimeout(() => {
            os.setAgentActive(senderId, false);
          }, 8000);
        }
      }
    });
    return unsub;
  }, []);

  // Auto-scroll message log
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [messages]);

  const handleClick = useCallback((_agentId: number) => {
    // Future: center camera on agent, show details
  }, []);

  const handleZoomChange = useCallback((newZoom: number) => {
    setZoom(newZoom);
  }, []);

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
          {/* Agent status dots */}
          {AGENT_CONFIGS.map((agent: AgentConfig) => (
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
          <div style={{
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
            isEditMode={false}
            editorState={null as any}
            onEditorTileAction={() => {}}
            onEditorEraseAction={() => {}}
            onEditorSelectionChange={() => {}}
            onDeleteSelected={() => {}}
            onRotateSelected={() => {}}
            onDragMove={() => {}}
            editorTick={0}
            zoom={zoom}
            onZoomChange={handleZoomChange}
            panRef={panRef}
          />
          <ToolOverlay
            officeState={getOfficeState()}
            agents={agents}
            agentTools={{}}
            subagentCharacters={[]}
            containerRef={containerRef}
            zoom={zoom}
            panRef={panRef}
            onCloseAgent={() => {}}
            alwaysShowOverlay={true}
          />
          <ZoomControls zoom={zoom} onZoomChange={handleZoomChange} />
          {/* Vignette */}
          <div style={{
            position: 'absolute',
            inset: 0,
            pointerEvents: 'none',
            background: 'radial-gradient(ellipse at center, transparent 60%, rgba(0,0,0,0.4) 100%)',
          }} />
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
            {messages.length === 0 ? (
              <div style={{
                textAlign: 'center',
                padding: '40px 16px',
                color: '#4b5563',
                fontSize: '12px',
                fontFamily: "'Inter', sans-serif",
              }}>
                {bridgeOnline
                  ? 'Waiting for messages...'
                  : 'Configure VITE_BRIDGE_API_KEY in .env to connect'}
              </div>
            ) : (
              messages.map((msg) => {
                const fromConfig = AGENT_CONFIGS.find((a) => a.agentId === msg.from);
                const toConfig = AGENT_CONFIGS.find((a) => a.agentId === msg.to);
                const time = new Date(msg.timestamp);
                const timeStr = time.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

                return (
                  <div key={msg.id} style={{
                    padding: '10px 12px',
                    marginBottom: '4px',
                    borderRadius: '6px',
                    background: '#14142a',
                    border: '1px solid #1e1e3a',
                    transition: 'background 0.2s',
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
                      <div style={{
                        width: '6px',
                        height: '6px',
                        borderRadius: '50%',
                        background: fromConfig?.color || '#6b7280',
                        flexShrink: 0,
                      }} />
                      <span style={{
                        fontSize: '11px',
                        fontWeight: 600,
                        color: fromConfig?.color || '#9ca3af',
                        fontFamily: "'Inter', sans-serif",
                      }}>
                        {getAgentDisplayName(msg.from)}
                      </span>
                      <span style={{ fontSize: '10px', color: '#4b5563' }}>→</span>
                      <span style={{
                        fontSize: '11px',
                        color: toConfig?.color || '#9ca3af',
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
              })
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

export default App;
