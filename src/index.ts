import webpush from "web-push";
import {
  MISSING_CYCLES_TO_DEACTIVATE,
  ALGOLIA_API_KEY,
  ALGOLIA_APP_ID,
  ALGOLIA_HITS_PER_PARTITION,
  ALGOLIA_INITIAL_PAGE_SIZE,
  ALGOLIA_MIN_PAGE_SIZE,
  ALGOLIA_INDEX,
  ALGOLIA_MAX_FACET_VALUES,
  ALGOLIA_PARTITION_TARGET_HITS,
  ALGOLIA_QUERY_ENDPOINT,
  GAME_FACET,
  GROUP_NOTIFICATION_THRESHOLD,
  MAX_PRIORITY_NOTIFICATIONS_PER_RUN,
  PARTITION_FACETS,
  PRICE_ENDPOINT,
  RECENT_EVENT_LIMIT,
  SALES_FACET,
} from "./config";

import {
  BADGE_96_BASE64,
  ICON_180_BASE64,
  ICON_192_BASE64,
  ICON_512_BASE64,
  ICON_MASKABLE_512_BASE64,
} from "./pwa-assets";

const APP_VERSION = "1.7.0";
const PROJECT_URL = "https://github.com/Gabriel-Liz2003/Eshop-Radar";
const UPDATE_MANIFEST_URL = "https://raw.githubusercontent.com/Gabriel-Liz2003/Eshop-Radar/main/version.json";

interface D1RunResult {
  meta?: { changes?: number };
}

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(columnName?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
  run(): Promise<D1RunResult>;
}

interface D1Database {
  prepare(query: string): D1PreparedStatement;
}

interface QueueProducer {
  send(message: unknown): Promise<unknown>;
}

interface QueueMessageBatch {
  ackAll(): void;
  retryAll(options?: { delaySeconds?: number }): void;
}

interface Env {
  DB: D1Database;
  SCAN_QUEUE: QueueProducer;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  ADMIN_TOKEN?: string;
}

interface SaleSnapshot {
  k: string;
  n: string;
  ids: string[];
}

interface KnownSale extends SaleSnapshot {
  a: 0 | 1;
  m: number;
}

interface RecentEvent {
  id: string;
  at: string;
  sales: SaleSnapshot[];
}

interface AppState {
  v: 4;
  initialized: boolean;
  nextPage: number;
  pageCount: number;
  scan: Record<string, SaleSnapshot>;
  known: Record<string, KnownSale>;
  pending: SaleSnapshot[];
  customTerms: string[];
  recent: RecentEvent[];
  lastRunAt: string | null;
  lastCycleAt: string | null;
  lastError: string | null;
  lastTotal: number;
  lastAddedCount: number;
  lastRemovedCount: number;
  cycles: number;
  notifications: number;
  gamesAlerted: number;
  suppressNextNotifications: boolean;
}

interface SalesPage {
  hits?: unknown[];
  nbHits?: number;
  nbPages?: number;
  page?: number;
  hitsPerPage?: number;
  facets?: Record<string, Record<string, number>>;
}

interface MultiQueryResponse {
  results?: SalesPage[];
}

interface PriceInfo {
  regular?: string;
  discount?: string;
  currency?: string;
  percent?: number;
  start?: string;
  end?: string;
}

const DB_SCHEMA = `
CREATE TABLE IF NOT EXISTS app_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  json TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`;

const PUSH_SCHEMA = `
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`;

const PUSH_DEDUPE_SCHEMA = `
CREATE TABLE IF NOT EXISTS push_dedupe (
  key TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`;

const defaultState = (): AppState => ({
  v: 4,
  initialized: false,
  nextPage: 0,
  pageCount: 0,
  scan: {},
  known: {},
  pending: [],
  customTerms: [],
  recent: [],
  lastRunAt: null,
  lastCycleAt: null,
  lastError: null,
  lastTotal: 0,
  lastAddedCount: 0,
  lastRemovedCount: 0,
  cycles: 0,
  notifications: 0,
  gamesAlerted: 0,
  suppressNextNotifications: false,
});

function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function isPriority(name: string, customTerms: string[]): boolean {
  const normalizedName = normalize(name);
  return customTerms.some((term) => normalizedName.includes(normalize(term)));
}

function fallbackHash(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i += 1) {
    hash = ((hash << 5) + hash) ^ input.charCodeAt(i);
  }
  return `h${(hash >>> 0).toString(16)}`;
}

function collectTitleIds(value: unknown, out = new Set<string>(), depth = 0): Set<string> {
  if (depth > 5 || value == null) return out;

  if (typeof value === "string" || typeof value === "number") {
    const candidate = String(value);
    if (/^7\d{13}$/.test(candidate)) out.add(candidate);
    return out;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectTitleIds(item, out, depth + 1);
    return out;
  }

  if (typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (["id", "title_id", "titleId", "nsuid", "titleid"].includes(key)) {
        collectTitleIds(child, out, depth + 1);
      } else if (depth < 2 && ["target_titles", "targetTitles", "titles"].includes(key)) {
        collectTitleIds(child, out, depth + 1);
      }
    }
  }

  return out;
}

function toSaleSnapshot(raw: unknown): SaleSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  const name = String(item.formal_name ?? item.name ?? item.title ?? "").trim();
  if (!name) return null;

  const ids = new Set<string>();
  collectTitleIds(item.nsuid, ids);
  collectTitleIds(item.titleId ?? item.title_id, ids);
  collectTitleIds(item.target_titles ?? item.targetTitles ?? [], ids);

  const objectId = item.objectID != null ? String(item.objectID) : undefined;
  const rawKey = objectId ?? (item.id != null ? String(item.id) : [...ids][0] ?? fallbackHash(name));
  return { k: rawKey, n: name, ids: [...ids] };
}

async function ensureDb(env: Env): Promise<void> {
  await env.DB.prepare(DB_SCHEMA).run();
  await env.DB.prepare(PUSH_SCHEMA).run();
  await env.DB.prepare(PUSH_DEDUPE_SCHEMA).run();
}

async function loadState(env: Env): Promise<AppState> {
  await ensureDb(env);
  const row = await env.DB.prepare("SELECT json FROM app_state WHERE id = 1").first<{ json: string }>();
  if (!row?.json) return defaultState();

  try {
    const parsed = JSON.parse(row.json) as Partial<AppState> & { v?: number };
    if ((parsed.v ?? 1) < 3) {
      return {
        ...defaultState(),
        customTerms: parsed.customTerms ?? [],
        notifications: parsed.notifications ?? 0,
        gamesAlerted: parsed.gamesAlerted ?? 0,
      };
    }

    const migratedFromPre166 = (parsed.v ?? 3) < 4;
    return {
      ...defaultState(),
      ...parsed,
      v: 4,
      scan: parsed.scan ?? {},
      known: parsed.known ?? {},
      pending: migratedFromPre166 ? [] : (parsed.pending ?? []),
      customTerms: parsed.customTerms ?? [],
      recent: parsed.recent ?? [],
      suppressNextNotifications: migratedFromPre166 ? true : (parsed.suppressNextNotifications ?? false),
    };
  } catch {
    return defaultState();
  }
}

async function saveState(env: Env, state: AppState): Promise<void> {
