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
  const now = new Date().toISOString();
  await env.DB.prepare(`
    INSERT INTO app_state (id, json, updated_at)
    VALUES (1, ?1, ?2)
    ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at
  `).bind(JSON.stringify(state), now).run();
}

type FacetFilter = string | string[];

function catalogParams(facetFilters: FacetFilter[], options: { facets?: string[]; hitsPerPage?: number; page?: number } = {}): string {
  const values: Record<string, string> = {
    query: "",
    distinct: "1",
    facetingAfterDistinct: "true",
    hitsPerPage: String(options.hitsPerPage ?? ALGOLIA_HITS_PER_PARTITION),
    page: String(options.page ?? 0),
    facetFilters: JSON.stringify(facetFilters),
    attributesToRetrieve: [
      "objectID",
      "title",
      "nsuid",
      "titleId",
      "title_id",
      "topLevelFilters",
      "productType",
      "type",
      "dlcType",
      "url",
      "price",
      "softwarePublisher",
      "priceRangeFilter",
    ].join(","),
  };
  if (options.facets?.length) {
    values.facets = options.facets.join(",");
    values.maxValuesPerFacet = String(ALGOLIA_MAX_FACET_VALUES);
  }
  return new URLSearchParams(values).toString();
}

async function algoliaErrorMessage(response: Response, prefix: string): Promise<Error> {
  let detail = "";
  try {
    detail = (await response.text()).replace(/\s+/g, " ").trim().slice(0, 240);
  } catch {}
  return new Error(`${prefix} HTTP ${response.status}${detail ? ` — ${detail}` : ""}`);
}

async function fetchCatalogMeta(facetFilters: FacetFilter[]): Promise<SalesPage> {
  const response = await fetch(ALGOLIA_QUERY_ENDPOINT, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "x-algolia-application-id": ALGOLIA_APP_ID,
      "x-algolia-api-key": ALGOLIA_API_KEY,
    },
    body: JSON.stringify({
      params: catalogParams(facetFilters, { facets: [...PARTITION_FACETS], hitsPerPage: 0 }),
    }),
  });
  if (!response.ok) throw await algoliaErrorMessage(response, "Nintendo catalog metadata");
  return await response.json() as SalesPage;
}

interface PartitionPlan {
  total: number;
  facet: string | null;
  filters: FacetFilter[][];
}

interface FacetBucketGroup {
  values: string[];
  count: number;
}

function groupFacetBuckets(entries: Array<[string, number]>): FacetBucketGroup[] {
  const groups: FacetBucketGroup[] = [];
  const sorted = [...entries].sort((a, b) => b[1] - a[1]);

  for (const [value, count] of sorted) {
    if (count > ALGOLIA_HITS_PER_PARTITION) {
      throw new Error(`Bucket ${value} tem ${count} jogos, acima do limite do Algolia.`);
    }

    let bestIndex = -1;
    let bestRemaining = Number.POSITIVE_INFINITY;
    for (let i = 0; i < groups.length; i += 1) {
      const next = groups[i].count + count;
      if (next <= ALGOLIA_PARTITION_TARGET_HITS) {
        const remaining = ALGOLIA_PARTITION_TARGET_HITS - next;
        if (remaining < bestRemaining) {
          bestRemaining = remaining;
          bestIndex = i;
        }
      }
    }

    if (bestIndex >= 0) {
      groups[bestIndex].values.push(value);
      groups[bestIndex].count += count;
    } else {
      groups.push({ values: [value], count });
    }
  }

  return groups;
}

async function buildPartitionPlan(): Promise<PartitionPlan> {
  const baseFilters: FacetFilter[] = [SALES_FACET, GAME_FACET];
  const meta = await fetchCatalogMeta(baseFilters);
  const total = Number(meta.nbHits ?? 0);
  if (total <= ALGOLIA_HITS_PER_PARTITION) {
    return { total, facet: null, filters: [baseFilters] };
  }

  const candidates: Array<{ facet: string; groups: FacetBucketGroup[] }> = [];
  for (const facet of PARTITION_FACETS) {
    const entries = Object.entries(meta.facets?.[facet] ?? {})
      .map(([value, count]) => [value, Number(count)] as [string, number])
      .filter(([value, count]) => value && Number.isFinite(count) && count > 0);
    if (!entries.length) continue;

    const covered = entries.reduce((sum, [, count]) => sum + count, 0);
    const max = Math.max(...entries.map(([, count]) => count));
    if (covered !== total || max > ALGOLIA_HITS_PER_PARTITION) continue;

    const groups = groupFacetBuckets(entries);
    candidates.push({ facet, groups });
  }

  candidates.sort((a, b) => {
    const aStable = a.facet === "softwarePublisher" ? 0 : 1;
    const bStable = b.facet === "softwarePublisher" ? 0 : 1;
    if (aStable !== bStable) return aStable - bStable;
    return a.groups.length - b.groups.length;
  });
  const chosen = candidates[0];
  if (!chosen) {
    throw new Error(`Não foi possível particionar ${total} promoções sem perder jogos. Facets do catálogo mudaram.`);
  }

  return {
    total,
    facet: chosen.facet,
    filters: chosen.groups.map((group) => {
      const publisherFilters = group.values.map((value) => `${chosen.facet}:${value}`);
      return [...baseFilters, publisherFilters];
    }),
  };
}

async function fetchPartitionPage(facetFilters: FacetFilter[], page: number, hitsPerPage: number): Promise<Response> {
  return fetch(ALGOLIA_QUERY_ENDPOINT, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "x-algolia-application-id": ALGOLIA_APP_ID,
      "x-algolia-api-key": ALGOLIA_API_KEY,
    },
    body: JSON.stringify({
      params: catalogParams(facetFilters, { page, hitsPerPage }),
    }),
  });
}

async function fetchAllPartitionPages(filters: FacetFilter[][]): Promise<SalesPage[]> {
  const partitions: SalesPage[] = [];

  for (const facetFilters of filters) {
    let pageSize = ALGOLIA_INITIAL_PAGE_SIZE;
    let firstResponse: Response | null = null;

    while (pageSize >= ALGOLIA_MIN_PAGE_SIZE) {
      const response = await fetchPartitionPage(facetFilters, 0, pageSize);
      if (response.ok) {
        firstResponse = response;
        break;
      }

      const detail = await response.text();
      const isDistinctLimit = response.status === 400
        && /hitsPerPage\s*\*\s*distinct|invalid distinct value/i.test(detail);
      if (!isDistinctLimit || pageSize === ALGOLIA_MIN_PAGE_SIZE) {
        const suffix = detail.replace(/\s+/g, " ").trim().slice(0, 240);
        throw new Error(`Nintendo catalog HTTP ${response.status}${suffix ? ` — ${suffix}` : ""}`);
      }

      pageSize = Math.max(ALGOLIA_MIN_PAGE_SIZE, Math.floor(pageSize / 2));
    }

    if (!firstResponse) throw new Error("Nintendo catalog: não foi possível escolher um tamanho de página válido.");

    const first = await firstResponse.json() as SalesPage;
    const hits: unknown[] = Array.isArray(first.hits) ? [...first.hits] : [];
    const nbPages = Math.max(1, Number(first.nbPages ?? 1));

    for (let page = 1; page < nbPages; page += 1) {
      const response = await fetchPartitionPage(facetFilters, page, pageSize);
      if (!response.ok) throw await algoliaErrorMessage(response, `Nintendo catalog página ${page}`);
      const payload = await response.json() as SalesPage;
      if (Array.isArray(payload.hits)) hits.push(...payload.hits);
    }

    partitions.push({ ...first, hits, hitsPerPage: pageSize, page: 0 });
  }

  return partitions;
}

function extractPriceObject(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== "object") return null;
  const root = payload as Record<string, unknown>;
  const prices = root.prices;
  if (Array.isArray(prices) && prices.length > 0 && prices[0] && typeof prices[0] === "object") {
    return prices[0] as Record<string, unknown>;
  }
  return null;
}

function readAmount(value: unknown): { amount?: string; raw?: number; currency?: string; start?: string; end?: string } {
  if (!value || typeof value !== "object") return {};
  const obj = value as Record<string, unknown>;
  const rawString = obj.raw_value != null ? String(obj.raw_value) : undefined;
  const raw = rawString ? Number(rawString.replace(",", ".")) : undefined;
  return {
    amount: obj.amount != null ? String(obj.amount) : undefined,
    raw: Number.isFinite(raw) ? raw : undefined,
    currency: obj.currency != null ? String(obj.currency) : undefined,
    start: obj.start_datetime != null ? String(obj.start_datetime) : undefined,
    end: obj.end_datetime != null ? String(obj.end_datetime) : undefined,
  };
}

async function fetchPrice(titleId: string): Promise<PriceInfo | null> {
  const url = new URL(PRICE_ENDPOINT);
  url.searchParams.set("country", "BR");
  url.searchParams.set("ids", titleId);
  url.searchParams.set("lang", "pt");

  const response = await fetch(url.toString(), { headers: { Accept: "application/json" } });
  if (!response.ok) return null;

  const payload = await response.json();
  const price = extractPriceObject(payload);
  if (!price) return null;

  const regular = readAmount(price.regular_price);
  const discount = readAmount(price.discount_price);
  let percent: number | undefined;
  if (regular.raw && discount.raw != null && regular.raw > 0 && discount.raw <= regular.raw) {
    percent = Math.round((1 - discount.raw / regular.raw) * 100);
  }

  return {
    regular: regular.amount,
    discount: discount.amount,
    currency: discount.currency ?? regular.currency,
    percent,
    start: discount.start,
    end: discount.end,
  };
}

function formatDate(value?: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
