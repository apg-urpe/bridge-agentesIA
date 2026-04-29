/**
 * Bridge Adapter — replaces browserMock.ts
 * Loads pixel art assets the same way browserMock did, then connects
 * to the URPE AI Lab Bridge to drive agent characters in real time.
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
import { fetchAgents, fetchThreads, type BridgeAgent, type BridgeMessage } from './bridgeClient.ts';

// ── Agent config ──────────────────────────────────────────────────────────────

export interface AgentConfig {
  agentId: string;
  displayName: string;
  palette: number;
  color: string;
}

export const AGENT_CONFIGS: AgentConfig[] = [
  { agentId: 'nexus-andres', displayName: 'NEXUS', palette: 0, color: '#3b82f6' },
  { agentId: 'rocky-assistant', displayName: 'Rocky', palette: 1, color: '#22c55e' },
  { agentId: 'pepper-potts', displayName: 'Pepper', palette: 2, color: '#ef4444' },
  { agentId: 'loki', displayName: 'Loki', palette: 3, color: '#a855f7' },
  { agentId: 'clawd-assistant', displayName: 'Clawd', palette: 4, color: '#f97316' },
];

export function getAgentConfig(agentId: string): AgentConfig | undefined {
  return AGENT_CONFIGS.find((c) => c.agentId === agentId);
}

export function getAgentDisplayName(agentId: string): string {
  return getAgentConfig(agentId)?.displayName || agentId;
}

// ── PNG decode (same as browserMock) ─────────────────────────────────────────

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

// ── Asset loading ─────────────────────────────────────────────────────────────

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

/** Dispatch asset messages to the webview engine (same format as browserMock) */
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

/** Dispatch agent creation messages for Bridge agents */
export function dispatchAgentMessages(bridgeAgents: BridgeAgent[]): void {
  // Create agents for each known config, in order
  for (let i = 0; i < AGENT_CONFIGS.length; i++) {
    const config = AGENT_CONFIGS[i];
    const bridgeAgent = bridgeAgents.find((a) => a.agent_id === config.agentId);
    if (!bridgeAgent) continue;

    window.dispatchEvent(new MessageEvent('message', {
      data: {
        type: 'agentCreated',
        id: i + 1, // numeric IDs 1-5
      },
    }));
  }

  console.log(`[BridgeAdapter] Created ${AGENT_CONFIGS.length} agent characters`);
}

// ── Polling ─────────────────────────────────────────────────────────────────

let lastSeenMessageId: string | null = null;
let pollingInterval: number | null = null;
let messageListeners: Array<(messages: BridgeMessage[]) => void> = [];

export function onNewMessages(listener: (messages: BridgeMessage[]) => void): () => void {
  messageListeners.push(listener);
  return () => { messageListeners = messageListeners.filter((l) => l !== listener); };
}

async function pollBridge(): Promise<void> {
  const threads = await fetchThreads();
  if (threads.length === 0) return;

  // Collect all messages, sorted by timestamp
  const allMessages: BridgeMessage[] = [];
  for (const thread of threads) {
    if (thread.messages) {
      allMessages.push(...thread.messages);
    }
  }
  allMessages.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  if (allMessages.length === 0) return;

  // Find new messages since last poll
  let newMessages: BridgeMessage[] = [];
  if (lastSeenMessageId) {
    const lastIdx = allMessages.findIndex((m) => m.message_id === lastSeenMessageId);
    if (lastIdx >= 0) {
      newMessages = allMessages.slice(lastIdx + 1);
    }
  } else {
    // First poll — show last 10 messages
    newMessages = allMessages.slice(-10);
  }

  if (allMessages.length > 0) {
    lastSeenMessageId = allMessages[allMessages.length - 1].message_id;
  }

  if (newMessages.length > 0) {
    for (const listener of messageListeners) {
      listener(newMessages);
    }
  }
}

export function startPolling(intervalMs = 5000): void {
  if (pollingInterval) return;
  pollBridge(); // immediate first poll
  pollingInterval = window.setInterval(pollBridge, intervalMs);
  console.log(`[BridgeAdapter] Polling started (${intervalMs}ms)`);
}

export function stopPolling(): void {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
  }
}

/** Get the numeric character ID for a bridge agent_id */
export function getCharacterId(agentId: string): number | null {
  const idx = AGENT_CONFIGS.findIndex((c) => c.agentId === agentId);
  return idx >= 0 ? idx + 1 : null;
}
