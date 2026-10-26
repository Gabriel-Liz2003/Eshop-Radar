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
const ANDROID_PACKAGE_ID = "com.gabrieldeliz.eshopradar";
const ANDROID_CERT_SHA256 = "31:ED:93:D1:40:75:78:1C:02:35:E6:DD:05:77:9F:7F:C9:A2:30:B8:B8:41:5F:16:CF:80:76:49:72:23:FA:A8";

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

// Guarda uma pequena chave por notificação para tornar o envio idempotente.
// Cloudflare Queues é "at least once", então uma mesma mensagem pode ser
// entregue novamente em retries raros. Sem essa tabela, um push enviado antes
// de um erro posterior poderia ser reenviado em sequência.
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

  // IMPORTANTE: a própria consulta Algolia já exige simultaneamente
  // topLevelFilters:Promoções + productType:Jogos. Portanto NÃO aplicamos
  // filtros por palavras do título aqui. Isso evita excluir jogos legítimos
  // como Demon Slayer ou Costume Quest e mantém o universo monitorado igual
  // ao universo contado por nbHits.
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
    // v3 troca o modo filtrado pelo monitoramento de TODOS os jogos em promoção.
    // O primeiro ciclo da migração vira um novo baseline para não disparar milhares
    // de alertas retroativos. Inscrições Web Push ficam em tabela separada e são mantidas.
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
      // A v1.6.6 limpa qualquer fila antiga potencialmente responsável pelo
      // spam e suprime UMA rodada de notificações. O ciclo ainda é salvo no
      // histórico e sincroniza o catálogo, então a lista reaparece no app sem
      // mandar novamente o lote que já foi recebido várias vezes.
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
    // O índice público da Nintendo agrupa variantes com distinct>1 por padrão.
    // Para monitorar JOGOS (e não registros/variantes), fixamos distinct=1.
    // Isso também faz nbHits representar o conjunto deduplicado que realmente
    // conseguimos paginar/monitorar.
    distinct: "1",
    // Os facets usados para particionar precisam ser calculados sobre o mesmo
    // universo deduplicado; caso contrário as somas podem contar variantes que
    // nunca aparecem nos hits e a cobertura fica artificialmente maior.
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
  } catch {
    // ignore
  }
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
  // First-fit decreasing: junta publicadoras pequenas em grupos disjuntos de
  // ~800 jogos. Isso reduz centenas de consultas para poucas partições, sem
  // ultrapassar o limite de 1000 hits por busca do Algolia.
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
    // Só usamos facets que cobrem exatamente o universo e em que nenhum valor
    // individual excede a janela de 1000 hits.
    if (covered !== total || max > ALGOLIA_HITS_PER_PARTITION) continue;

    const groups = groupFacetBuckets(entries);
    candidates.push({ facet, groups });
  }

  candidates.sort((a, b) => {
    // Publicadora tende a ser estável entre variantes do mesmo jogo; faixa de
    // preço pode mudar entre edição/base/bundle. Em empate (ou perto dele),
    // preferimos softwarePublisher para reduzir duplicação entre partições.
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
      // Uma lista aninhada em facetFilters é OR. Como cada jogo pertence a um
      // único bucket desta facet, os grupos continuam disjuntos.
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

  // O índice da Nintendo usa distinct=N. O Algolia exige
  // hitsPerPage * distinct <= 1000. Em vez de assumir o valor de distinct,
  // começamos com 500 e reduzimos automaticamente se a API rejeitar a página.
  // Cada partição tem <= 800 jogos, então mesmo com paginação continuamos
  // dentro do limite de subrequests do Worker.
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
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

interface StoredPushSubscription {
  endpoint: string;
  expirationTime?: number | null;
  keys: { p256dh: string; auth: string };
}

function assertPushConfigured(env: Env): { publicKey: string; privateKey: string } {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) {
    throw new Error("Web Push ainda não configurado");
  }
  return { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY };
}

async function savePushSubscription(env: Env, subscription: StoredPushSubscription): Promise<void> {
  await ensureDb(env);
  const now = new Date().toISOString();
  await env.DB.prepare(`
    INSERT INTO push_subscriptions (endpoint, json, created_at, updated_at)
    VALUES (?1, ?2, ?3, ?3)
    ON CONFLICT(endpoint) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at
  `).bind(subscription.endpoint, JSON.stringify(subscription), now).run();
}

async function deletePushSubscription(env: Env, endpoint: string): Promise<void> {
  await ensureDb(env);
  await env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?1").bind(endpoint).run();
}

async function listPushSubscriptions(env: Env): Promise<StoredPushSubscription[]> {
  await ensureDb(env);
  const rows = await env.DB.prepare("SELECT json FROM push_subscriptions ORDER BY created_at").all<{ json: string }>();
  const out: StoredPushSubscription[] = [];
  for (const row of rows.results ?? []) {
    try {
      const parsed = JSON.parse(row.json) as StoredPushSubscription;
      if (parsed?.endpoint && parsed?.keys?.p256dh && parsed?.keys?.auth) out.push(parsed);
    } catch {
      // Ignora linha corrompida; uma nova inscrição substitui depois.
    }
  }
  return out;
}

async function pushSubscriptionCount(env: Env): Promise<number> {
  await ensureDb(env);
  const row = await env.DB.prepare("SELECT COUNT(*) AS c FROM push_subscriptions").first<{ c: number }>();
  return Number(row?.c ?? 0);
}

async function sendWebPush(env: Env, payload: { title: string; body: string; url?: string; tag?: string }): Promise<number> {
  const vapid = assertPushConfigured(env);
  const subscriptions = await listPushSubscriptions(env);
  if (subscriptions.length === 0) throw new Error("Nenhum celular inscrito nas notificações");

  let sent = 0;
  let lastError: unknown = null;
  for (const subscription of subscriptions) {
    try {
      await webpush.sendNotification(
        subscription,
        JSON.stringify(payload),
        {
          TTL: 3600,
          urgency: "high",
          vapidDetails: {
            subject: "mailto:eshop-br-alert@example.com",
            publicKey: vapid.publicKey,
            privateKey: vapid.privateKey,
          },
        },
      );
      sent += 1;
    } catch (error) {
      const statusCode = Number((error as { statusCode?: number })?.statusCode ?? 0);
      if (statusCode === 404 || statusCode === 410) {
        await deletePushSubscription(env, subscription.endpoint);
        continue;
      }
      lastError = error;
    }
  }

  if (sent === 0) {
    const detail = lastError instanceof Error ? lastError.message : lastError ? String(lastError) : "nenhuma inscrição válida";
    throw new Error(`Web Push falhou: ${detail}`);
  }
  return sent;
}

function notificationKey(prefix: string, cycleAt: string | null, sales: SaleSnapshot[]): string {
  const ids = sales.map((sale) => sale.k).sort().join("|");
  return `${prefix}:${fallbackHash(`${cycleAt ?? "unknown"}|${ids}`)}`;
}

async function beginPushAttempt(env: Env, key: string): Promise<"send" | "sent" | "wait"> {
  await ensureDb(env);
  const row = await env.DB.prepare(
    "SELECT status, updated_at FROM push_dedupe WHERE key = ?1",
  ).bind(key).first<{ status: string; updated_at: string }>();

  if (row?.status === "sent") return "sent";
  if (row?.status === "sending") {
    const age = Date.now() - new Date(row.updated_at).getTime();
    // Se outra entrega da Queue estiver terminando, não envia de novo. Se ela
    // morreu depois do push e antes do ACK, liberamos uma nova tentativa só
    // depois de 2 minutos. O tag estável do Service Worker impede empilhamento.
    if (Number.isFinite(age) && age < 120_000) return "wait";
  }

  const now = new Date().toISOString();
  await env.DB.prepare(`
    INSERT INTO push_dedupe (key, status, updated_at)
    VALUES (?1, 'sending', ?2)
    ON CONFLICT(key) DO UPDATE SET status = 'sending', updated_at = excluded.updated_at
  `).bind(key, now).run();
  return "send";
}

async function markPushSent(env: Env, key: string): Promise<void> {
  await env.DB.prepare(
    "UPDATE push_dedupe SET status = 'sent', updated_at = ?2 WHERE key = ?1",
  ).bind(key, new Date().toISOString()).run();
}

async function releasePushAttempt(env: Env, key: string): Promise<void> {
  await env.DB.prepare("DELETE FROM push_dedupe WHERE key = ?1").bind(key).run();
}

async function prunePushDedupe(env: Env): Promise<void> {
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  await env.DB.prepare("DELETE FROM push_dedupe WHERE updated_at < ?1").bind(cutoff).run();
}

async function publishPush(env: Env, sale: SaleSnapshot, price: PriceInfo | null, stableTag: string): Promise<void> {
  const discountText = price?.discount ?? "Preço promocional detectado";
  const regularText = price?.regular ? `de ${price.regular} por ${discountText}` : discountText;
  const percentText = price?.percent != null ? ` (-${price.percent}%)` : "";
  const endText = formatDate(price?.end);
  const titleId = sale.ids[0];
  const click = titleId ? `https://ec.nintendo.com/titles/${encodeURIComponent(titleId)}/redirect` : undefined;

  const body = [
    regularText + percentText,
    "Nintendo eShop Brasil",
    endText ? `Termina em ${endText}` : null,
  ].filter(Boolean).join("\n");

  await sendWebPush(env, {
    title: `🎮 ${sale.n} entrou em promoção`,
    body,
    url: click,
    tag: stableTag,
  });
}

async function publishTest(env: Env): Promise<void> {
  await sendWebPush(env, {
    title: "✅ eShop BR Alert funcionando",
    body: "O Cloudflare Worker conseguiu enviar Web Push direto para este celular.",
  });
}

function pushRecentEvent(state: AppState, sales: SaleSnapshot[]): void {
  if (!sales.length) return;
  state.recent.unshift({
    id: `${Date.now()}-${sales.length}`,
    at: new Date().toISOString(),
    sales: sales.slice(0, 500),
  });
  state.recent = state.recent.slice(0, RECENT_EVENT_LIMIT);
}

function finishCycle(state: AppState): void {
  const current = state.scan;
  const nowKeys = new Set(Object.keys(current));
  const newSales: SaleSnapshot[] = [];
  let removed = 0;

  if (!state.initialized) {
    for (const sale of Object.values(current)) {
      state.known[sale.k] = { ...sale, a: 1, m: 0 };
    }
    state.initialized = true;
  } else {
    for (const sale of Object.values(current)) {
      const previous = state.known[sale.k];
      const becameActive = !previous || previous.a === 0;
      state.known[sale.k] = { ...sale, a: 1, m: 0 };
      if (becameActive) {
        newSales.push(sale);
        if (!state.suppressNextNotifications && !state.pending.some((item) => item.k === sale.k)) {
          state.pending.push(sale);
        }
      }
    }

    for (const [key, sale] of Object.entries(state.known)) {
      if (sale.a === 1 && !nowKeys.has(key)) {
        const misses = (sale.m ?? 0) + 1;
        if (misses >= MISSING_CYCLES_TO_DEACTIVATE) {
          delete state.known[key];
          removed += 1;
        } else {
          state.known[key] = { ...sale, m: misses, a: 1 };
        }
      }
    }
  }

  state.lastAddedCount = newSales.length;
  state.lastRemovedCount = removed;
  pushRecentEvent(state, newSales);
  // Só a primeira rodada após atualizar de <=1.6.5 é silenciosa. Ela existe
  // para sincronizar o estado que ficou preso durante o spam de retries.
  state.suppressNextNotifications = false;
  state.scan = {};
  state.nextPage = 0;
  state.cycles += 1;
  state.lastCycleAt = new Date().toISOString();
}

async function publishGroupedPush(env: Env, sales: SaleSnapshot[], stableTag: string): Promise<void> {
  const preview = sales.slice(0, 4).map((sale) => sale.n);
  const extra = Math.max(0, sales.length - preview.length);
  const body = [
    preview.join(" · "),
    extra > 0 ? `+${extra} outro${extra === 1 ? "" : "s"}` : null,
    "Toque para ver a lista no eShop BR Alert.",
  ].filter(Boolean).join("\n");

  await sendWebPush(env, {
    title: `🔥 ${sales.length} jogos entraram em promoção`,
    body,
    url: "/app#recentes",
    tag: stableTag,
  });
}

async function flushPending(env: Env, state: AppState): Promise<void> {
  if (state.pending.length === 0) return;

  const original = [...state.pending];
  const priority = original.filter((sale) => isPriority(sale.n, state.customTerms));
  const normal = original.filter((sale) => !isPriority(sale.n, state.customTerms));
  const processed = new Set<string>();
  let pushMessages = 0;
  let gamesAlerted = 0;

  const sendIndividual = async (sale: SaleSnapshot): Promise<boolean> => {
    const key = notificationKey("sale", state.lastCycleAt, [sale]);
    const claim = await beginPushAttempt(env, key);
    if (claim === "sent") {
      // Já foi entregue numa execução anterior; limpa apenas a fila local.
      processed.add(sale.k);
      return true;
    }
    if (claim === "wait") return false;

    try {
      const price = sale.ids[0] ? await fetchPrice(sale.ids[0]) : null;
      await publishPush(env, sale, price, key);
      await markPushSent(env, key);
      processed.add(sale.k);
      pushMessages += 1;
      gamesAlerted += 1;
      return true;
    } catch (error) {
      await releasePushAttempt(env, key).catch(() => undefined);
      state.lastError = `Falha ao notificar ${sale.n}: ${error instanceof Error ? error.message : String(error)}`;
      return false;
    }
  };

  // Wishlist/termos personalizados continuam recebendo alerta próprio.
  for (const sale of priority.slice(0, MAX_PRIORITY_NOTIFICATIONS_PER_RUN)) {
    const ok = await sendIndividual(sale);
    if (!ok) break;
  }

  const remainingNormal = normal.filter((sale) => !processed.has(sale.k));
  if (remainingNormal.length > 0) {
    if (original.length >= GROUP_NOTIFICATION_THRESHOLD) {
      const key = notificationKey("group", state.lastCycleAt, remainingNormal);
      const claim = await beginPushAttempt(env, key);
      if (claim === "sent") {
        for (const sale of remainingNormal) processed.add(sale.k);
      } else if (claim === "send") {
        try {
          await publishGroupedPush(env, remainingNormal, key);
          await markPushSent(env, key);
          for (const sale of remainingNormal) processed.add(sale.k);
          pushMessages += 1;
          gamesAlerted += remainingNormal.length;
        } catch (error) {
          await releasePushAttempt(env, key).catch(() => undefined);
          state.lastError = `Falha ao enviar alertas: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
    } else {
      for (const sale of remainingNormal) {
        const ok = await sendIndividual(sale);
        if (!ok) break;
      }
    }
  }

  if (processed.size > 0) {
    state.pending = state.pending.filter((sale) => !processed.has(sale.k));
    state.notifications += pushMessages;
    state.gamesAlerted += gamesAlerted;
  }
}

async function runCheck(env: Env): Promise<AppState> {
  const state = await loadState(env);
  state.lastRunAt = new Date().toISOString();
  state.lastError = null;

  try {
    const plan = await buildPartitionPlan();
    state.pageCount = plan.filters.length;
    state.nextPage = 0;
    state.scan = {};

    const pages = await fetchAllPartitionPages(plan.filters);
    for (const page of pages) {
      if (!Array.isArray(page.hits)) {
        state.nextPage += 1;
        continue;
      }
      for (const raw of page.hits) {
        const sale = toSaleSnapshot(raw);
        if (sale) state.scan[sale.k] = sale;
      }
      state.nextPage += 1;
    }

    state.lastTotal = Object.keys(state.scan).length;
    // plan.total e os facet counts já são deduplicados (distinct=1). Se o parser
    // obtiver menos que isso, interrompemos o ciclo para nunca transformar uma
    // falha de coleta em centenas de falsos "encerramentos" de promoção.
    if (plan.total > 0 && state.lastTotal < Math.floor(plan.total * 0.98)) {
      throw new Error(`Cobertura inesperada do catálogo deduplicado: ${state.lastTotal}/${plan.total} jogos.`);
    }

    finishCycle(state);

    // Persistimos o novo catálogo, o histórico e a fila ANTES de qualquer
    // notificação externa. Se a Queue repetir a mensagem ou a execução morrer
    // depois de um push, a próxima execução já enxerga o ciclo como concluído
    // em vez de detectar o mesmo lote de novo.
    await saveState(env, state);
    await prunePushDedupe(env);
    await flushPending(env, state);
  } catch (error) {
    state.lastError = error instanceof Error ? error.message : String(error);
  }

  await saveState(env, state);
  return state;
}

const ADMIN_COOKIE = "__Host-eshop_admin";
const PAIR_WINDOW_MS = 5 * 60 * 1000;

function cookieValue(request: Request, name: string): string | null {
  const cookie = request.headers.get("Cookie") ?? "";
  for (const part of cookie.split(";")) {
    const [rawKey, ...rawValue] = part.trim().split("=");
    if (rawKey === name) return decodeURIComponent(rawValue.join("="));
  }
  return null;
}

function isAdmin(request: Request, env: Env): boolean {
  if (!env.ADMIN_TOKEN) return false;
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  const auth = request.headers.get("Authorization");
  const cookieToken = cookieValue(request, ADMIN_COOKIE);
  return token === env.ADMIN_TOKEN
    || auth === `Bearer ${env.ADMIN_TOKEN}`
    || cookieToken === env.ADMIN_TOKEN;
}


async function pairCodeForWindow(secret: string, windowNumber: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`eshop-br-pair:${windowNumber}`),
  ));
  const value = (((signature[0] << 24) >>> 0) | (signature[1] << 16) | (signature[2] << 8) | signature[3]) >>> 0;
  return String(value % 100_000_000).padStart(8, "0");
}

async function currentPairCode(env: Env): Promise<string> {
  if (!env.ADMIN_TOKEN) return "";
  return pairCodeForWindow(env.ADMIN_TOKEN, Math.floor(Date.now() / PAIR_WINDOW_MS));
}

async function validPairCode(env: Env, candidate: string): Promise<boolean> {
  if (!env.ADMIN_TOKEN || !/^\d{8}$/.test(candidate)) return false;
  const nowWindow = Math.floor(Date.now() / PAIR_WINDOW_MS);
  const current = await pairCodeForWindow(env.ADMIN_TOKEN, nowWindow);
  const previous = await pairCodeForWindow(env.ADMIN_TOKEN, nowWindow - 1);
  return candidate === current || candidate === previous;
}

function publicStatus(state: AppState): Record<string, unknown> {
  const active = Object.values(state.known).filter((sale) => sale.a === 1).length;
  return {
    service: "eShop BR Alert",
    version: APP_VERSION,
    mode: "todos-os-jogos",
    initialized: state.initialized,
    lastRunAt: state.lastRunAt,
    lastCycleAt: state.lastCycleAt,
    promotionsSeen: state.lastTotal,
    activeTrackedPromotions: active,
    lastAddedCount: state.lastAddedCount,
    lastRemovedCount: state.lastRemovedCount,
    scanProgress: state.nextPage === 0 && state.lastCycleAt
      ? `${state.pageCount}/${state.pageCount} partições (último ciclo)`
      : `${Math.min(state.nextPage, state.pageCount)}/${state.pageCount} partições`,
    pendingGames: state.pending.length,
    pushMessagesSent: state.notifications,
    gamesAlerted: state.gamesAlerted,
    cyclesCompleted: state.cycles,
    recentEvents: state.recent.slice(0, 3).map((event) => ({ at: event.at, count: event.sales.length })),
    lastError: state.lastError,
  };
}

interface UpdateManifest {
  version: string;
  notes?: string;
  download_url?: string;
  release_url?: string;
  published_at?: string;
  android?: {
    version?: string;
    version_code?: number;
    apk_url?: string;
    release_url?: string;
    package_id?: string;
  };
}

function versionParts(version: string): number[] {
  return version
    .trim()
    .replace(/^v/i, "")
    .split(/[.-]/)
    .slice(0, 3)
    .map((part) => Number.parseInt(part, 10) || 0);
}

function compareVersions(a: string, b: string): number {
  const aa = versionParts(a);
  const bb = versionParts(b);
  for (let i = 0; i < 3; i += 1) {
    if ((aa[i] ?? 0) > (bb[i] ?? 0)) return 1;
    if ((aa[i] ?? 0) < (bb[i] ?? 0)) return -1;
  }
  return 0;
}

async function updateInfo(installedAndroidVersion?: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${UPDATE_MANIFEST_URL}?t=${Date.now()}`, {
    headers: {
      Accept: "application/json",
      "User-Agent": "Eshop-Radar-Update-Check",
    },
  });
  if (!response.ok) throw new Error(`GitHub version manifest HTTP ${response.status}`);
  const manifest = await response.json() as UpdateManifest;
  if (!manifest?.version || !/^v?\d+\.\d+\.\d+/.test(manifest.version)) {
    throw new Error("Manifesto de versão inválido no GitHub.");
  }

  const androidLatest = manifest.android?.version?.replace(/^v/i, "") ?? null;
  const androidCurrent = installedAndroidVersion && /^v?\d+\.\d+\.\d+/.test(installedAndroidVersion)
    ? installedAndroidVersion.replace(/^v/i, "")
    : null;

  return {
    currentVersion: APP_VERSION,
    latestVersion: manifest.version.replace(/^v/i, ""),
    updateAvailable: compareVersions(manifest.version, APP_VERSION) > 0,
    notes: manifest.notes ?? "",
    downloadUrl: manifest.download_url ?? PROJECT_URL,
    releaseUrl: manifest.release_url ?? PROJECT_URL,
    publishedAt: manifest.published_at ?? null,
    projectUrl: PROJECT_URL,
    android: {
      currentVersion: androidCurrent,
      latestVersion: androidLatest,
      updateAvailable: !!(androidCurrent && androidLatest && compareVersions(androidLatest, androidCurrent) > 0),
      apkUrl: manifest.android?.apk_url ?? null,
      releaseUrl: manifest.android?.release_url ?? manifest.release_url ?? PROJECT_URL,
      packageId: manifest.android?.package_id ?? ANDROID_PACKAGE_ID,
    },
  };
}

function htmlResponse(html: string, status = 200, extraHeaders?: Record<string, string>): Response {
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
  });
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function assetLinksResponse(): Response {
  return new Response(JSON.stringify([
    {
      relation: ["delegate_permission/common.handle_all_urls"],
      target: {
        namespace: "android_app",
        package_name: ANDROID_PACKAGE_ID,
        sha256_cert_fingerprints: [ANDROID_CERT_SHA256],
      },
    },
  ], null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}

function binaryBase64Response(base64: string, contentType: string): Response {
  const raw = atob(base64);
  const bytes = Uint8Array.from(raw, (ch) => ch.charCodeAt(0));
  return new Response(bytes, {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=604800, immutable",
    },
  });
}

function redirectApp(): Response {
  return new Response(null, { status: 303, headers: { Location: "/app" } });
}

function establishAdminSession(request: Request, env: Env): Response | null {
  if (!env.ADMIN_TOKEN) return null;
  const token = new URL(request.url).searchParams.get("token");
  if (token !== env.ADMIN_TOKEN) return null;
  return new Response(null, {
    status: 303,
    headers: {
      Location: "/app",
      "Set-Cookie": `${ADMIN_COOKIE}=${encodeURIComponent(env.ADMIN_TOKEN)}; Max-Age=31536000; Path=/; Secure; HttpOnly; SameSite=Lax`,
      "Cache-Control": "no-store",
    },
  });
}

function clearAdminSession(): Response {
  return new Response(null, {
    status: 303,
    headers: {
      Location: "/",
      "Set-Cookie": `${ADMIN_COOKIE}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax`,
      "Cache-Control": "no-store",
    },
  });
}

function manifestResponse(): Response {
  const manifest = {
    id: "/app",
    name: "eShop BR Alert",
    short_name: "eShop BR",
    description: "Alertas automáticos de todos os jogos que entram em promoção na Nintendo eShop Brasil.",
    start_url: "/app",
    scope: "/",
    display: "standalone",
    display_override: ["standalone", "minimal-ui"],
    orientation: "portrait-primary",
    background_color: "#0f1115",
    theme_color: "#0f1115",
    categories: ["games", "shopping", "utilities"],
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "Painel", short_name: "Painel", url: "/app", icons: [{ src: "/icon-192.png", sizes: "192x192" }] },
      { name: "Status público", short_name: "Status", url: "/status", icons: [{ src: "/icon-192.png", sizes: "192x192" }] },
    ],
  };
  return new Response(JSON.stringify(manifest), {
    headers: {
      "Content-Type": "application/manifest+json; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}

function offlinePage(): string {
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#0f1115"><title>eShop BR Alert — offline</title>
<style>:root{color-scheme:dark;font-family:system-ui,sans-serif}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f1115;color:#f4f7fb;padding:28px;text-align:center}.box{max-width:430px;background:#1a1e26;border:1px solid #303641;border-radius:24px;padding:28px;box-shadow:0 18px 60px #0007}img{width:96px;height:96px;border-radius:24px}h1{margin:16px 0 8px}.muted{color:#aab2bf;line-height:1.55}button{font:inherit;border:0;border-radius:12px;padding:12px 18px;background:#32cd91;color:#07150f;font-weight:800}</style></head>
<body><main class="box"><img src="/icon-192.png" alt=""><h1>Sem conexão</h1><p class="muted">O monitor continua rodando na Cloudflare. O painel volta assim que o celular recuperar a internet.</p><button onclick="location.reload()">Tentar novamente</button></main></body></html>`;
}

function unauthorizedPage(errorMessage = ""): string {
  const error = errorMessage ? `<p style="color:#ff7b72"><b>${escapeHtml(errorMessage)}</b></p>` : "";
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#0f1115"><title>eShop BR Alert</title><style>:root{color-scheme:dark;font-family:system-ui,sans-serif}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f1115;color:#f4f7fb;padding:28px}.box{width:min(100%,480px);background:#1a1e26;border:1px solid #303641;border-radius:22px;padding:26px}code{word-break:break-word;color:#7ee787}.pair{margin-top:22px;padding-top:20px;border-top:1px solid #343a45}input,button{font:inherit;border-radius:12px;padding:12px 14px}input{width:100%;background:#0d1117;color:#fff;border:1px solid #49515e;font-size:26px;letter-spacing:.18em;text-align:center;font-weight:800}button{width:100%;margin-top:10px;border:0;background:#32cd91;color:#07150f;font-weight:850;min-height:48px}small{color:#aab2bf}</style></head><body><main class="box"><h1>🔒 Painel protegido</h1><p>O Brave e o app instalado estão usando sessões separadas neste aparelho. Vincule o app uma única vez com um código temporário.</p>${error}<div class="pair"><h2>Vincular este app</h2><p><small>No Brave normal, abra seu painel privado e toque em <b>Gerar código para o app</b>. Digite aqui os 8 números.</small></p><form method="post" action="/pair"><input name="code" inputmode="numeric" pattern="[0-9]{8}" maxlength="8" autocomplete="one-time-code" placeholder="00000000" required><button type="submit">Vincular e abrir painel</button></form></div></main><script>try{const apk=new URLSearchParams(location.search).get('apk');if(apk&&/^v?\\d+\\.\\d+\\.\\d+/.test(apk))localStorage.setItem('eshop-android-wrapper-version',apk.replace(/^v/i,''));}catch{}</script></body></html>`;
}

function pairingCodePage(code: string): string {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#0f1115"><title>Vincular eShop BR</title><style>:root{color-scheme:dark;font-family:system-ui,sans-serif}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f1115;color:#f4f7fb;padding:28px}.box{width:min(100%,460px);background:#1a1e26;border:1px solid #303641;border-radius:22px;padding:26px;text-align:center}.code{font-size:44px;letter-spacing:.16em;font-weight:900;margin:22px 0;color:#7ee787}.muted{color:#aab2bf;line-height:1.5}a{color:#75aaff}</style></head><body><main class="box"><h1>📱 Vincular PWA</h1><p class="muted">Digite este código no app eShop BR instalado. Ele vale por aproximadamente 5 minutos.</p><div class="code">${escapeHtml(code)}</div><p class="muted">Depois de vincular, o app mantém a própria sessão e você não precisa repetir isso.</p><p><a href="/app">Voltar ao painel</a></p></main></body></html>`;
}

function adminPage(state: AppState, env: Env, subscriptions: number): string {
  const active = Object.values(state.known).filter((sale) => sale.a === 1).length;
  const vapidPublicKey = env.VAPID_PUBLIC_KEY ?? "";
  const custom = state.customTerms.length
    ? state.customTerms.map((term) => `
        <li><code>${escapeHtml(term)}</code>
          <form method="post" action="/admin/watch/remove" style="display:inline">
            <input type="hidden" name="term" value="${escapeHtml(term)}">
            <button type="submit" class="ghost tiny">remover</button>
          </form>
        </li>`).join("")
    : "<li>Nenhum termo personalizado.</li>";

  const since24h = Date.now() - 24 * 60 * 60 * 1000;
  const newLast24h = state.recent
    .filter((event) => new Date(event.at).getTime() >= since24h)
    .reduce((sum, event) => sum + event.sales.length, 0);
  const recentHtml = state.recent.length
    ? state.recent.map((event, index) => {
        const when = formatDate(event.at) ?? event.at;
        const rows = event.sales.map((sale) => {
          const titleId = sale.ids[0];
          const label = escapeHtml(sale.n);
          return titleId
            ? `<li><a href="https://ec.nintendo.com/titles/${encodeURIComponent(titleId)}/redirect" target="_blank" rel="noopener">${label}</a></li>`
            : `<li>${label}</li>`;
        }).join("");
        return `<details ${index === 0 ? "open" : ""}><summary><b>${event.sales.length} jogo${event.sales.length === 1 ? "" : "s"}</b> · ${escapeHtml(when)}</summary><ul class="recent-list">${rows}</ul></details>`;
      }).join("")
    : '<p class="muted">Nenhuma promoção nova foi detectada desde o baseline deste modo.</p>';

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0f1115">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="eShop BR">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" type="image/png" sizes="192x192" href="/icon-192.png">
<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">
<title>eShop BR Alert</title>
<style>
  :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:#0f1115; }
  * { box-sizing:border-box; }
  body { max-width:900px; margin:0 auto; min-height:100vh; padding:calc(22px + env(safe-area-inset-top)) 18px calc(30px + env(safe-area-inset-bottom)); background:radial-gradient(circle at 50% -10%,#18342b 0,#0f1115 32%); color:#f4f7fb; }
  header { display:flex; align-items:center; gap:14px; margin:4px 0 22px; }
  .logo { width:58px; height:58px; border-radius:16px; box-shadow:0 10px 28px #0006; }
  h1 { margin:0; font-size:clamp(29px,7vw,44px); line-height:1; letter-spacing:-.035em; }
  h2 { margin:0 0 12px; font-size:20px; }
  .subtitle { margin:6px 0 0; color:#aeb6c3; font-size:14px; }
  .card { background:#191d24eF; border:1px solid #303640; border-radius:20px; padding:18px; margin:14px 0; box-shadow:0 14px 36px #0004; backdrop-filter:blur(12px); }
  .ok { color:#7ee787; } .err { color:#ff7b72; } code { word-break:break-all; }
  button, input { font:inherit; padding:11px 13px; border-radius:11px; border:1px solid #4a5260; }
  button { cursor:pointer; border:0; background:#32cd91; color:#07150f; font-weight:800; min-height:44px; }
  button:disabled { opacity:.55; cursor:not-allowed; }
  button.ghost { background:#262c35; color:#eef2f7; border:1px solid #3e4653; }
  button.tiny { padding:7px 10px; min-height:auto; font-size:13px; }
  input { width:min(100%,460px); background:#0c0f14; color:#eee; }
  form { margin:9px 0; } a { color:#75aaff; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:10px; }
  .metric { background:#0c0f14; border:1px solid #242a33; border-radius:14px; padding:14px; min-height:88px; }
  .metric b { display:block; margin-top:5px; font-size:23px; }
  small,.muted { color:#aab2bf; }
  .status { font-size:18px; font-weight:750; margin:0 0 12px; }
  .actions { display:flex; flex-wrap:wrap; gap:9px; align-items:center; }
  .install-card { border-color:#2e7258; background:linear-gradient(145deg,#18251f,#191d24); }
  .pill { display:inline-flex; align-items:center; gap:6px; padding:6px 9px; border-radius:999px; background:#0d2d22; color:#7ee7b7; font-size:12px; font-weight:800; }
  ul { padding-left:22px; }
  details { border-top:1px solid #303640; padding:12px 0; }
  details:first-of-type { border-top:0; }
  summary { cursor:pointer; color:#e7ebf2; }
  .recent-list { max-height:360px; overflow:auto; padding-right:8px; }
  .recent-list li { margin:7px 0; }
  footer { padding:18px 4px 0; text-align:center; color:#818a98; font-size:12px; }
  @media (display-mode: standalone) { .browser-only { display:none !important; } body { padding-top:calc(14px + env(safe-area-inset-top)); } }
</style>
</head>
<body>
<header><img class="logo" src="/icon-192.png" alt=""><div><h1>eShop BR Alert</h1><p class="subtitle">Todas as promoções de jogos da Nintendo eShop Brasil</p></div></header>
<p class="status ${state.lastError ? "err" : "ok"}">${state.lastError ? `Último erro: ${escapeHtml(state.lastError)}` : "● Monitor operacional"}</p>
<div class="card grid">
  <div class="metric"><small>Inicializado</small><b>${state.initialized ? "Sim" : "Criando baseline"}</b></div>
  <div class="metric"><small>Jogos em promoção</small><b>${state.lastTotal}</b></div>
  <div class="metric"><small>Ativas rastreadas</small><b>${active}</b></div>
  <div class="metric"><small>Partições do catálogo</small><b>${state.nextPage === 0 && state.lastCycleAt
    ? `${state.pageCount}/${state.pageCount}`
    : `${Math.min(state.nextPage, state.pageCount)}/${state.pageCount}`}</b></div>
  <div class="metric"><small>Novos nas últimas 24h</small><b>${newLast24h}</b></div>
  <div class="metric"><small>Fila de jogos</small><b>${state.pending.length}</b></div>
  <div class="metric"><small>Jogos alertados</small><b>${state.gamesAlerted}</b></div>
  <div class="metric"><small>Pushes enviados</small><b>${state.notifications}</b></div>
</div>
<div class="card" id="recentes">
  <h2>🆕 Promoções novas</h2>
  <p class="muted">Histórico das entradas detectadas. Lotes com 4+ jogos geram um único push agrupado.</p>
  ${recentHtml}
</div>
<div class="card install-card" id="install-card">
  <span class="pill">📱 PWA</span>
  <h2 style="margin-top:10px">Instalar como aplicativo</h2>
  <p class="muted" id="install-status">Instale na tela inicial para abrir em tela cheia, com ícone próprio e sem a barra do navegador.</p>
  <div class="actions"><button type="button" id="install-app">⬇️ Instalar eShop BR Alert</button></div>
</div>
<div class="card browser-only">
  <h2>Vincular app instalado</h2>
  <p class="muted">Se o PWA mostrar “Painel protegido”, gere um código temporário e digite-o dentro do app.</p>
  <div class="actions"><a href="/pair" style="text-decoration:none"><button type="button" class="ghost">🔐 Gerar código para o app</button></a></div>
</div>
<div class="card">
  <h2>Notificações</h2>
  <p>Web Push direto pelo próprio Worker. Não depende de ntfy, Discord ou Telegram.</p>
  <p><b>Celulares inscritos:</b> ${subscriptions}</p>
  ${vapidPublicKey ? `<div class="actions"><button type="button" id="enable-push">🔔 Ativar notificações neste celular</button>
  <form method="post" action="/admin/test"><button type="submit" class="ghost">Enviar notificação de teste</button></form></div>
  <p id="push-status"><small>As notificações continuam funcionando mesmo com o app fechado.</small></p>` : `<p class="err">VAPID ainda não configurado. Rode <code>npm run upgrade-push</code>.</p>`}
</div>
<div class="card">
  <h2>⭐ Wishlist / prioridade</h2>
  <p class="muted">Todos os jogos já são monitorados. Itens desta lista recebem notificação individual mesmo quando entram junto com um lote grande.</p>
  <form method="post" action="/admin/watch/add">
    <input name="term" placeholder="Ex.: Fantasy Life i" required maxlength="120">
    <button type="submit">Adicionar</button>
  </form>
  <ul>${custom}</ul>
</div>
<div class="card" id="updates">
  <h2>🔄 Atualizações</h2>
  <p>Versão instalada: <b>v${APP_VERSION}</b></p>
  <p class="muted">O app consulta o repositório oficial no GitHub. A verificação automática ocorre no máximo uma vez a cada 6 horas, e você também pode verificar manualmente.</p>
  <div class="actions"><button type="button" id="check-update">Verificar atualizações</button>
  <a href="${PROJECT_URL}" target="_blank" rel="noopener" style="text-decoration:none"><button type="button" class="ghost">Abrir GitHub</button></a></div>
  <p id="update-status"><small>Ainda não verificado nesta sessão.</small></p>
  <div id="update-actions" class="actions"></div>
</div>
<div class="card">
  <h2>Controle</h2>
  <div class="actions"><form method="post" action="/admin/check"><button type="submit">Rodar verificação agora</button></form></div>
  <p><small>Última execução: ${escapeHtml(state.lastRunAt ?? "ainda não")}</small><br>
  <small>Último ciclo completo: ${escapeHtml(state.lastCycleAt ?? "ainda não")}</small><br>
  <small>Última mudança: +${state.lastAddedCount} novas · -${state.lastRemovedCount} encerradas</small></p>
</div>
<footer>eShop BR Alert v${APP_VERSION} · <a href="/status">status público</a> · <a href="/logout">sair deste navegador</a></footer>
<script>
const vapidPublicKey = ${JSON.stringify(vapidPublicKey)};
let deferredInstallPrompt = null;
const installButton = document.getElementById('install-app');
const installStatus = document.getElementById('install-status');
const installCard = document.getElementById('install-card');
const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
let androidWrapperVersion = null;
try {
  const fromUrl = new URLSearchParams(location.search).get('apk');
  if (fromUrl && /^v?\d+\.\d+\.\d+/.test(fromUrl)) {
    localStorage.setItem('eshop-android-wrapper-version', fromUrl.replace(/^v/i, ''));
  }
  androidWrapperVersion = localStorage.getItem('eshop-android-wrapper-version');
} catch {}

async function registerSW() {
  if (!('serviceWorker' in navigator)) return null;
  try { return await navigator.serviceWorker.register('/sw.js'); } catch { return null; }
}
registerSW();

if (isStandalone) {
  installButton.hidden = true;
  installStatus.textContent = '✅ Aplicativo instalado. Você já está usando a versão em tela cheia.';
} else {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    installButton.hidden = false;
    installStatus.textContent = 'Pronto para instalar. Toque no botão abaixo.';
  });
  setTimeout(() => {
    if (!deferredInstallPrompt) installStatus.textContent = 'Se o botão não abrir a instalação, use o menu ⋮ do Brave e escolha “Instalar app” ou “Adicionar à tela inicial”.';
  }, 1800);
}

installButton?.addEventListener('click', async () => {
  if (!deferredInstallPrompt) {
    installStatus.textContent = 'No Brave, abra o menu ⋮ e toque em “Instalar app” ou “Adicionar à tela inicial”.';
    return;
  }
  deferredInstallPrompt.prompt();
  const choice = await deferredInstallPrompt.userChoice;
  installStatus.textContent = choice.outcome === 'accepted' ? '✅ Instalado. Procure o ícone eShop BR na tela inicial.' : 'Instalação cancelada.';
  deferredInstallPrompt = null;
});
window.addEventListener('appinstalled', () => {
  installStatus.textContent = '✅ eShop BR Alert instalado.';
  installButton.hidden = true;
});

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map(ch => ch.charCodeAt(0)));
}
async function enablePush() {
  const status = document.getElementById('push-status');
  const button = document.getElementById('enable-push');
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) throw new Error('Este navegador não oferece Web Push. Tente Chrome ou Brave atualizado.');
    button.disabled = true;
    status.textContent = 'Pedindo permissão...';
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') throw new Error('Permissão de notificações não concedida.');
    const registration = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(vapidPublicKey) });
    }
    const response = await fetch('/admin/push/subscribe', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(subscription) });
    if (!response.ok) throw new Error('Falha ao salvar inscrição: HTTP ' + response.status);
    status.textContent = '✅ Notificações ativadas neste celular. Atualize a página para ver a contagem.';
  } catch (error) {
    status.textContent = '❌ ' + (error?.message || String(error));
  } finally { button.disabled = false; }
}
async function checkForUpdates(manual = false) {
  const button = document.getElementById('check-update');
  const status = document.getElementById('update-status');
  const actions = document.getElementById('update-actions');
  if (!button || !status || !actions) return;
  button.disabled = true;
  status.textContent = 'Consultando o GitHub...';
  actions.replaceChildren();

  const addDownloadButton = (label, href) => {
    if (!href) return;
    const download = document.createElement('a');
    download.href = href;
    download.target = '_blank';
    download.rel = 'noopener';
    download.style.textDecoration = 'none';
    const downloadButton = document.createElement('button');
    downloadButton.type = 'button';
    downloadButton.textContent = label;
    download.appendChild(downloadButton);
    actions.appendChild(download);
  };

  try {
    const endpoint = androidWrapperVersion
      ? '/admin/update/check?android=' + encodeURIComponent(androidWrapperVersion)
      : '/admin/update/check';
    const response = await fetch(endpoint, { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data?.error || ('HTTP ' + response.status));
    localStorage.setItem('eshop-last-update-check', String(Date.now()));

    const webUpdate = !!data.updateAvailable;
    const androidUpdate = !!data.android?.updateAvailable;

    if (webUpdate) {
      addDownloadButton('⬇️ Baixar atualização do projeto', data.downloadUrl || data.releaseUrl || data.projectUrl);
    }
    if (androidUpdate) {
      addDownloadButton('📱 Baixar APK v' + data.android.latestVersion, data.android.apkUrl || data.android.releaseUrl);
    }

    if (webUpdate || androidUpdate) {
      const parts = [];
      if (webUpdate) parts.push('Web/PWA v' + data.latestVersion + ' disponível (instalada: v' + data.currentVersion + ')');
      if (androidUpdate) parts.push('APK v' + data.android.latestVersion + ' disponível (instalado: v' + data.android.currentVersion + ')');
      status.textContent = '⬆️ ' + parts.join(' · ') + (data.notes ? '. ' + data.notes : '');
    } else if (androidWrapperVersion && data.android?.latestVersion) {
      status.textContent = '✅ Web/PWA v' + data.currentVersion + ' e APK v' + data.android.currentVersion + ' estão atualizados.';
    } else {
      status.textContent = '✅ Você está na versão mais recente: v' + data.currentVersion + '.';
    }
  } catch (error) {
    status.textContent = '❌ Não foi possível verificar: ' + (error?.message || String(error));
  } finally {
    button.disabled = false;
  }
}

document.getElementById('check-update')?.addEventListener('click', () => checkForUpdates(true));
try {
  const last = Number(localStorage.getItem('eshop-last-update-check') || 0);
  if (!last || Date.now() - last > 6 * 60 * 60 * 1000) setTimeout(() => checkForUpdates(false), 1200);
} catch {}

document.getElementById('enable-push')?.addEventListener('click', enablePush);
</script>
</body></html>`;
}

async function addCustomTerm(env: Env, term: string): Promise<AppState> {
  const state = await loadState(env);
  const clean = term.trim().slice(0, 120);
  if (!clean) return state;

  const exists = state.customTerms.some((current) => normalize(current) === normalize(clean));
  if (!exists) state.customTerms.push(clean);

  for (const sale of Object.values(state.known)) {
    if (sale.a === 1 && normalize(sale.n).includes(normalize(clean))) {
      if (!state.pending.some((item) => item.k === sale.k)) {
        state.pending.push({ k: sale.k, n: sale.n, ids: sale.ids });
      }
    }
  }

  await saveState(env, state);
  return state;
}

async function removeCustomTerm(env: Env, term: string): Promise<AppState> {
  const state = await loadState(env);
  state.customTerms = state.customTerms.filter((current) => normalize(current) !== normalize(term));
  await saveState(env, state);
  return state;
}

function serviceWorkerScript(): string {
  return `const CACHE = 'eshop-br-alert-v1.7.0';
const STATIC = ['/offline','/manifest.webmanifest','/icon-192.png','/icon-512.png','/icon-maskable-512.png'];
self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(STATIC)).catch(() => undefined));
});
self.addEventListener('activate', event => {
  event.waitUntil(Promise.all([
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))),
    self.clients.claim(),
  ]));
});
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match('/offline')));
    return;
  }
  if (url.pathname.startsWith('/icon-') || url.pathname === '/apple-touch-icon.png' || url.pathname === '/manifest.webmanifest') {
    event.respondWith(caches.match(request).then(hit => hit || fetch(request)));
  }
});
self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data ? event.data.text() : '' }; }
  const title = data.title || 'eShop BR Alert';
  const options = {
    body: data.body || '',
    icon: '/icon-192.png',
    badge: '/badge-96.png',
    data: { url: data.url || '/app' },
    tag: data.tag || data.url || 'eshop-br-alert',
    // Com tag estável, um eventual retry substitui a notificação anterior em
    // vez de empilhar outra idêntica na barra do Android.
    renotify: false,
  };
  event.waitUntil(self.registration.showNotification(title, options));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data && event.notification.data.url ? event.notification.data.url : '/app';
  event.waitUntil(clients.openWindow(url));
});`;
}

function jsResponse(code: string): Response {
  return new Response(code, {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "no-cache",
      "Service-Worker-Allowed": "/",
    },
  });
}

function isValidPushSubscription(value: unknown): value is StoredPushSubscription {
  if (!value || typeof value !== "object") return false;
  const sub = value as Partial<StoredPushSubscription>;
  return typeof sub.endpoint === "string"
    && sub.endpoint.startsWith("https://")
    && !!sub.keys
    && typeof sub.keys.p256dh === "string"
    && typeof sub.keys.auth === "string";
}

async function enqueueScan(env: Env, source: "cron" | "manual" = "cron"): Promise<void> {
  await env.SCAN_QUEUE.send({ type: "scan", source, at: new Date().toISOString() });
}

export default {
  async scheduled(_controller: unknown, env: Env): Promise<void> {
    // O plano Free permite só 10 ms de CPU por Cron. O cron agora faz apenas
    // uma operação baratíssima: enfileira o trabalho pesado. O scan completo
    // roda no Queue Consumer, que tem um orçamento de CPU muito maior.
    await enqueueScan(env, "cron");
  },

  async queue(batch: QueueMessageBatch, env: Env): Promise<void> {
    try {
      // Mesmo que vários ticks tenham acumulado, um único scan já representa
      // o estado atual da eShop. max_concurrency=1 evita corridas no D1.
      await runCheck(env);
      batch.ackAll();
    } catch (error) {
      // Erro de infraestrutura fora do runCheck: tenta novamente depois.
      batch.retryAll({ delaySeconds: 30 });
      throw error;
    }
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/sw.js") return jsResponse(serviceWorkerScript());
    if (url.pathname === "/manifest.webmanifest") return manifestResponse();
    if (url.pathname === "/.well-known/assetlinks.json") return assetLinksResponse();
    if (url.pathname === "/offline") return htmlResponse(offlinePage());
    if (url.pathname === "/icon-192.png") return binaryBase64Response(ICON_192_BASE64, "image/png");
    if (url.pathname === "/icon-512.png") return binaryBase64Response(ICON_512_BASE64, "image/png");
    if (url.pathname === "/icon-maskable-512.png") return binaryBase64Response(ICON_MASKABLE_512_BASE64, "image/png");
    if (url.pathname === "/apple-touch-icon.png") return binaryBase64Response(ICON_180_BASE64, "image/png");
    if (url.pathname === "/badge-96.png") return binaryBase64Response(BADGE_96_BASE64, "image/png");

    if (url.pathname === "/" || url.pathname === "/status") {
      const state = await loadState(env);
      return jsonResponse(publicStatus(state));
    }

    // O link privado antigo continua válido. Na primeira abertura, ele cria
    // uma sessão HttpOnly e remove o token da barra de endereço.
    if (url.pathname === "/admin" && request.method === "GET") {
      const session = establishAdminSession(request, env);
      if (session) return session;
      if (isAdmin(request, env)) return redirectApp();
      return htmlResponse(unauthorizedPage(), 401);
    }

    if (url.pathname === "/logout") return clearAdminSession();

    if (url.pathname === "/pair" && request.method === "GET") {
      if (!isAdmin(request, env)) return htmlResponse(unauthorizedPage(), 401);
      return htmlResponse(pairingCodePage(await currentPairCode(env)));
    }

    if (url.pathname === "/pair" && request.method === "POST") {
      const form = await request.formData();
      const code = String(form.get("code") ?? "").trim();
      if (!(await validPairCode(env, code))) return htmlResponse(unauthorizedPage("Código inválido ou expirado."), 401);
      return new Response(null, {
        status: 303,
        headers: {
          Location: "/app",
          "Set-Cookie": `${ADMIN_COOKIE}=${encodeURIComponent(env.ADMIN_TOKEN ?? "")}; Max-Age=31536000; Path=/; Secure; HttpOnly; SameSite=Lax`,
          "Cache-Control": "no-store",
        },
      });
    }

    if (url.pathname === "/app" && request.method === "GET") {
      if (!isAdmin(request, env)) return htmlResponse(unauthorizedPage(), 401);
      const state = await loadState(env);
      const subscriptions = await pushSubscriptionCount(env);
      return htmlResponse(adminPage(state, env, subscriptions));
    }

    if (!url.pathname.startsWith("/admin")) return jsonResponse({ error: "Not found" }, 404);
    if (!isAdmin(request, env)) return jsonResponse({ error: "Unauthorized" }, 401);

    if (url.pathname === "/admin/push/subscribe" && request.method === "POST") {
      try {
        const body = await request.json();
        if (!isValidPushSubscription(body)) return jsonResponse({ error: "Invalid push subscription" }, 400);
        await savePushSubscription(env, body);
        return jsonResponse({ ok: true });
      } catch (error) {
        return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 400);
      }
    }

    if (url.pathname === "/admin/update/check" && request.method === "GET") {
      try {
        return jsonResponse(await updateInfo(url.searchParams.get("android") ?? undefined));
      } catch (error) {
        return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 502);
      }
    }

    if (url.pathname === "/admin/test" && request.method === "POST") {
      try {
        await publishTest(env);
        return redirectApp();
      } catch (error) {
        return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 500);
      }
    }

    if (url.pathname === "/admin/check" && request.method === "POST") {
      await enqueueScan(env, "manual");
      return redirectApp();
    }

    if (url.pathname === "/admin/watch/add" && request.method === "POST") {
      const form = await request.formData();
      await addCustomTerm(env, String(form.get("term") ?? ""));
      return redirectApp();
    }

    if (url.pathname === "/admin/watch/remove" && request.method === "POST") {
      const form = await request.formData();
      await removeCustomTerm(env, String(form.get("term") ?? ""));
      return redirectApp();
    }

    return jsonResponse({ error: "Not found" }, 404);
  },
};
