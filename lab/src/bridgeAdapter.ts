/**
 * Bridge Adapter — connects the pixel office canvas to the Bridge.
 *
 * Loads pixel art assets, builds a dynamic agent registry from the public
 * /v1/agents endpoint, and forwards live messages from the SSE feed
 * (/v1/office/feed) to listeners. No API key required.
 */

import { rgbaToHex } from '../shared/assets/colorUtils.ts';
import {
  CHAR_FRAME_H,
  CHAR_FRAME_W,
  CHAR_FRAMES_PER_ROW,
  CHARACTER_DIRECTIONS,
  FLOOR_TILE_SIZE,
  WALL_BITMASK_COUNT,
  WALL_GRID_COLS,
  WALL_PIECE_HEIGHT,
  WALL_PIECE_WIDTH,
} from '../shared/assets/constants.ts';
import type {
  AssetIndex,
  CatalogEntry,
  CharacterDirectionSprites,
} from '../shared/assets/types.ts';
import {
  connectOfficeFeed,
  fetchAgents,
  fetchOfficeHistory,
  type BridgeAgent,
  type OfficeFeedEvent,
} from './bridgeClient.ts';

// ── Agent registry (built at runtime from /v1/agents) ──────────────────────

export interface AgentEntry {
  agentId: string;
  displayName: string;
  platform: string | null;
  characterId: number;   // 1-based numeric id for OfficeState
  palette: number;       // 0..PALETTE_COUNT-1
  hueShift: number;      // 0..360 for color variety within a palette
  color: string;         // hex used by header dots / log
  /** Pre-formatted "Nombre Apellido" (or just one if only one is set). Empty string if no owner. */
  ownerLabel: string;
}

const PALETTE_COUNT = 6;
const COLOR_RING = [
  '#3b82f6', // blue
  '#22c55e', // green
  '#ef4444', // red
  '#a855f7', // purple
  '#f97316', // orange
  '#eab308', // yellow
];

const agentRegistry = new Map<string, AgentEntry>();
const registryListeners: Array<(entries: AgentEntry[]) => void> = [];

function emitRegistry(): void {
  const entries = Array.from(agentRegistry.values());
  for (const l of registryListeners) l(entries);
}

export function onAgentsChanged(listener: (entries: AgentEntry[]) => void): () => void {
  registryListeners.push(listener);
  listener(Array.from(agentRegistry.values()));
  return () => {
    const idx = registryListeners.indexOf(listener);
    if (idx >= 0) registryListeners.splice(idx, 1);
  };
}

export function getAgentEntry(agentId: string): AgentEntry | undefined {
  return agentRegistry.get(agentId);
}

export function getAgentDisplayName(agentId: string): string {
  return agentRegistry.get(agentId)?.displayName || agentId;
}

export function getCharacterId(agentId: string): number | null {
  return agentRegistry.get(agentId)?.characterId ?? null;
}

/** Take the part of the registered display_name before the first parenthesis,
 * trimmed. "Rocky (OpenClaw/Claude)" → "Rocky". Names without "(" pass through. */
function shortDisplayName(name: string): string {
  const idx = name.indexOf('(');
  const head = idx >= 0 ? name.slice(0, idx) : name;
  return head.trim();
}

/** Combine owner first/last name into a display label, trimming blanks. */
function formatOwnerLabel(first: string | null | undefined, last: string | null | undefined): string {
  return [first, last].map((s) => (s || '').trim()).filter(Boolean).join(' ');
}

/** Resolve appearance with backend overrides falling through to a stable hash. */
function deriveAppearance(ba: BridgeAgent): { palette: number; hueShift: number; color: string } {
  const palette = ba.palette ?? (stableHash(ba.agent_id) % PALETTE_COUNT);
  const hueShift = ba.hue_shift ?? ((stableHash(ba.agent_id + ':hue') % 24) * 15);
  // If the agent picked their own hue, use it directly as the UI accent so
  // dots/log labels match the in-office tint. Otherwise fall back to the ring.
  const color = ba.hue_shift !== null && ba.hue_shift !== undefined
    ? `hsl(${ba.hue_shift}, 75%, 60%)`
    : COLOR_RING[stableHash(ba.agent_id) % COLOR_RING.length];
  return { palette, hueShift, color };
}

/**
 * Build/update the registry from /v1/agents. Stable: existing characterIds are
 * preserved across refreshes so animations don't jump. New agents get the next
 * free numeric id. Existing agents whose `palette` or `hue_shift` changed get
 * a hot-swap event so the engine retints the on-screen sprite without reload.
 */
async function refreshAgents(): Promise<AgentEntry[]> {
  const bridgeAgents: BridgeAgent[] = await fetchAgents();
  bridgeAgents.sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));

  let nextId = 1;
  for (const e of agentRegistry.values()) {
    if (e.characterId >= nextId) nextId = e.characterId + 1;
  }

  let changed = false;
  for (const ba of bridgeAgents) {
    const { palette, hueShift, color } = deriveAppearance(ba);
    const shortName = shortDisplayName(ba.display_name || '') || ba.agent_id;
    const ownerLabel = formatOwnerLabel(ba.owner_first_name, ba.owner_last_name);
    const existing = agentRegistry.get(ba.agent_id);
    if (existing) {
      const nameChanged = existing.displayName !== shortName;
      const appearanceChanged = existing.palette !== palette || existing.hueShift !== hueShift;
      const ownerChanged = existing.ownerLabel !== ownerLabel;
      if (appearanceChanged || nameChanged || ownerChanged) {
        existing.palette = palette;
        existing.hueShift = hueShift;
        existing.color = color;
        existing.displayName = shortName;
        existing.platform = ba.platform ?? null;
        existing.ownerLabel = ownerLabel;
        if (appearanceChanged) {
          window.dispatchEvent(new MessageEvent('message', {
            data: {
              type: 'agentAppearanceChanged',
              id: existing.characterId,
              palette,
              hueShift,
            },
          }));
        }
        changed = true;
      }
      continue;
    }
    const entry: AgentEntry = {
      agentId: ba.agent_id,
      displayName: shortName,
      platform: ba.platform ?? null,
      characterId: nextId++,
      palette,
      hueShift,
      color,
      ownerLabel,
    };
    agentRegistry.set(ba.agent_id, entry);
    changed = true;
  }

  if (changed) emitRegistry();
  return Array.from(agentRegistry.values());
}

function stableHash(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

// ── PNG decode ─────────────────────────────────────────────────────────────

interface DecodedPng {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

function getPixel(
  data: Uint8ClampedArray,
  width: number,
  x: number,
  y: number,
): [number, number, number, number] {
  const idx = (y * width + x) * 4;
  return [data[idx], data[idx + 1], data[idx + 2], data[idx + 3]];
}

function readSprite(
  png: DecodedPng,
  width: number,
  height: number,
  offsetX = 0,
  offsetY = 0,
): string[][] {
  const sprite: string[][] = [];
  for (let y = 0; y < height; y++) {
    const row: string[] = [];
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = getPixel(png.data, png.width, offsetX + x, offsetY + y);
      row.push(rgbaToHex(r, g, b, a));
    }
    sprite.push(row);
  }
  return sprite;
}

async function decodePng(url: string): Promise<DecodedPng> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch PNG: ${url} (${res.status})`);
  const blob = await res.blob();
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) { bitmap.close(); throw new Error('No 2d ctx'); }
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { width: canvas.width, height: canvas.height, data: imageData.data };
}

async function fetchJsonOptional<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch { return null; }
}

function getIndexedAssetPath(kind: 'characters' | 'floors' | 'walls', relPath: string): string {
  return relPath.startsWith(`${kind}/`) ? relPath : `${kind}/${relPath}`;
}

async function decodeCharactersFromPng(base: string, index: AssetIndex): Promise<CharacterDirectionSprites[]> {
  const sprites: CharacterDirectionSprites[] = [];
  for (const relPath of index.characters) {
    const png = await decodePng(`${base}assets/${getIndexedAssetPath('characters', relPath)}`);
    const byDir: CharacterDirectionSprites = { down: [], up: [], right: [] };
    for (let dirIdx = 0; dirIdx < CHARACTER_DIRECTIONS.length; dirIdx++) {
      const dir = CHARACTER_DIRECTIONS[dirIdx];
      const rowOffsetY = dirIdx * CHAR_FRAME_H;
      const frames: string[][][] = [];
      for (let frame = 0; frame < CHAR_FRAMES_PER_ROW; frame++) {
        frames.push(readSprite(png, CHAR_FRAME_W, CHAR_FRAME_H, frame * CHAR_FRAME_W, rowOffsetY));
      }
      byDir[dir] = frames;
    }
    sprites.push(byDir);
  }
  return sprites;
}

async function decodeFloorsFromPng(base: string, index: AssetIndex): Promise<string[][][]> {
  const floors: string[][][] = [];
  for (const relPath of index.floors) {
    const png = await decodePng(`${base}assets/${getIndexedAssetPath('floors', relPath)}`);
    floors.push(readSprite(png, FLOOR_TILE_SIZE, FLOOR_TILE_SIZE));
  }
  return floors;
}

async function decodeWallsFromPng(base: string, index: AssetIndex): Promise<string[][][][]> {
  const wallSets: string[][][][] = [];
  for (const relPath of index.walls) {
    const png = await decodePng(`${base}assets/${getIndexedAssetPath('walls', relPath)}`);
    const set: string[][][] = [];
    for (let mask = 0; mask < WALL_BITMASK_COUNT; mask++) {
      const ox = (mask % WALL_GRID_COLS) * WALL_PIECE_WIDTH;
      const oy = Math.floor(mask / WALL_GRID_COLS) * WALL_PIECE_HEIGHT;
      set.push(readSprite(png, WALL_PIECE_WIDTH, WALL_PIECE_HEIGHT, ox, oy));
    }
    wallSets.push(set);
  }
  return wallSets;
}

async function decodeFurnitureFromPng(
  base: string,
  catalog: CatalogEntry[],
): Promise<Record<string, string[][]>> {
  const sprites: Record<string, string[][]> = {};
  for (const entry of catalog) {
    const png = await decodePng(`${base}assets/${entry.furniturePath}`);
    sprites[entry.id] = readSprite(png, entry.width, entry.height);
  }
  return sprites;
}

// ── Asset loading ─────────────────────────────────────────────────────────

interface AssetPayload {
  characters: CharacterDirectionSprites[];
  floorSprites: string[][][];
  wallSets: string[][][][];
  furnitureCatalog: CatalogEntry[];
  furnitureSprites: Record<string, string[][]>;
  layout: unknown;
}

let assetPayload: AssetPayload | null = null;

export async function loadAssets(): Promise<void> {
  console.log('[BridgeAdapter] Loading assets...');
  const base = import.meta.env.BASE_URL;

  const [assetIndex, catalog] = await Promise.all([
    fetch(`${base}assets/asset-index.json`).then((r) => r.json()) as Promise<AssetIndex>,
    fetch(`${base}assets/furniture-catalog.json`).then((r) => r.json()) as Promise<CatalogEntry[]>,
  ]);

  const shouldTryDecoded = import.meta.env.DEV;
  const [decodedChars, decodedFloors, decodedWalls, decodedFurniture] = shouldTryDecoded
    ? await Promise.all([
        fetchJsonOptional<CharacterDirectionSprites[]>(`${base}assets/decoded/characters.json`),
        fetchJsonOptional<string[][][]>(`${base}assets/decoded/floors.json`),
        fetchJsonOptional<string[][][][]>(`${base}assets/decoded/walls.json`),
        fetchJsonOptional<Record<string, string[][]>>(`${base}assets/decoded/furniture.json`),
      ])
    : [null, null, null, null];

  const hasDecoded = !!(decodedChars && decodedFloors && decodedWalls && decodedFurniture);

  const [characters, floorSprites, wallSets, furnitureSprites] = hasDecoded
    ? [decodedChars!, decodedFloors!, decodedWalls!, decodedFurniture!]
    : await Promise.all([
        decodeCharactersFromPng(base, assetIndex),
        decodeFloorsFromPng(base, assetIndex),
        decodeWallsFromPng(base, assetIndex),
        decodeFurnitureFromPng(base, catalog),
      ]);

  const layout = assetIndex.defaultLayout
    ? await fetch(`${base}assets/${assetIndex.defaultLayout}`).then((r) => r.json())
    : null;

  assetPayload = { characters, floorSprites, wallSets, furnitureCatalog: catalog, furnitureSprites, layout };
  console.log(`[BridgeAdapter] Assets ready — ${characters.length} chars, ${floorSprites.length} floors, ${wallSets.length} walls, ${catalog.length} furniture`);
}

/** Dispatch asset messages to the engine. */
export function dispatchAssetMessages(): void {
  if (!assetPayload) return;
  const { characters, floorSprites, wallSets, furnitureCatalog, furnitureSprites, layout } = assetPayload;

  function dispatch(data: unknown): void {
    window.dispatchEvent(new MessageEvent('message', { data }));
  }

  dispatch({ type: 'characterSpritesLoaded', characters });
  dispatch({ type: 'floorTilesLoaded', sprites: floorSprites });
  dispatch({ type: 'wallTilesLoaded', sets: wallSets });
  dispatch({ type: 'furnitureAssetsLoaded', catalog: furnitureCatalog, sprites: furnitureSprites });
  dispatch({ type: 'layoutLoaded', layout });
  dispatch({
    type: 'settingsLoaded',
    soundEnabled: false,
    extensionVersion: '1.0.0',
    lastSeenVersion: '1.0.0',
  });

  console.log('[BridgeAdapter] Asset messages dispatched');
}

/**
 * Refresh the agent registry from /v1/agents and dispatch `agentCreated`
 * events for any new entries. Returns the up-to-date registry.
 */
export async function syncAgents(): Promise<AgentEntry[]> {
  const before = new Set(agentRegistry.keys());
  const entries = await refreshAgents();
  for (const entry of entries) {
    if (before.has(entry.agentId)) continue;
    window.dispatchEvent(new MessageEvent('message', {
      data: {
        type: 'agentCreated',
        id: entry.characterId,
        palette: entry.palette,
        hueShift: entry.hueShift,
      },
    }));
  }
  console.log(`[BridgeAdapter] Registry: ${entries.length} agents`);
  return entries;
}

// ── Live message feed ─────────────────────────────────────────────────────

export interface LiveMessage {
  id: string;
  from: string;
  to: string;
  message: string;
  thread_id: string | null;
  created_at: string;
}

let messageListeners: Array<(messages: LiveMessage[]) => void> = [];
let cancelFeed: (() => void) | null = null;
let agentRefreshHandle: number | null = null;
let statusListeners: Array<(s: 'connecting' | 'open' | 'closed') => void> = [];

/** Load the persisted message history (oldest first) from the bridge DB. */
export async function loadHistory(limit = 200): Promise<LiveMessage[]> {
  const rows = await fetchOfficeHistory(limit);
  return rows.map((r) => ({
    id: r.id,
    from: r.from,
    to: r.to,
    message: r.message,
    thread_id: r.thread_id,
    created_at: r.created_at,
  }));
}

export function onNewMessages(listener: (messages: LiveMessage[]) => void): () => void {
  messageListeners.push(listener);
  return () => { messageListeners = messageListeners.filter((l) => l !== listener); };
}

export function onFeedStatus(listener: (s: 'connecting' | 'open' | 'closed') => void): () => void {
  statusListeners.push(listener);
  return () => { statusListeners = statusListeners.filter((l) => l !== listener); };
}

function handleFeedEvent(event: OfficeFeedEvent): void {
  if (event.type !== 'message') return;
  // If the sender/recipient is unknown locally, refresh the registry. This
  // covers the case where a new agent registered after the SPA loaded.
  if (!agentRegistry.has(event.from) || !agentRegistry.has(event.to)) {
    syncAgents().catch((err) => console.warn('[BridgeAdapter] syncAgents failed', err));
  }
  const live: LiveMessage = {
    id: event.id,
    from: event.from,
    to: event.to,
    message: event.message,
    thread_id: event.thread_id,
    created_at: event.created_at,
  };
  for (const listener of messageListeners) listener([live]);
}

/**
 * Start the SSE subscription and a periodic /v1/agents refresh (every 30s)
 * so newly registered agents appear without requiring a page reload.
 */
export function startFeed(): void {
  if (cancelFeed) return;
  cancelFeed = connectOfficeFeed(
    handleFeedEvent,
    (status) => { for (const l of statusListeners) l(status); },
  );
  agentRefreshHandle = window.setInterval(() => {
    syncAgents().catch((err) => console.warn('[BridgeAdapter] periodic syncAgents failed', err));
  }, 30000);
  console.log('[BridgeAdapter] SSE feed started');
}

export function stopFeed(): void {
  if (cancelFeed) { cancelFeed(); cancelFeed = null; }
  if (agentRefreshHandle !== null) { clearInterval(agentRefreshHandle); agentRefreshHandle = null; }
}
