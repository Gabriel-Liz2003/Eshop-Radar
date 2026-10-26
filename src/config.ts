export const IGNORE_TERMS = [
  "demo", "season pass", "passe de temporada", "expansion pass",
  "trilha sonora", "soundtrack", "digital artbook", "art book",
  "costume", "cosmetic", "skin pack", "moedas", "currency pack"
] as const;

// Catálogo público usado pela Nintendo Store Brasil.
export const ALGOLIA_QUERY_ENDPOINT = "https://U3B6GR4UA3-dsn.algolia.net/1/indexes/store_all_products_pt_br/query";
export const ALGOLIA_INDEX = "store_all_products_pt_br";
export const ALGOLIA_APP_ID = "U3B6GR4UA3";
export const ALGOLIA_API_KEY = "a29c6927638bfd8cee23993e51e721c9";
export const SALES_FACET = "topLevelFilters:Promoções";
export const GAME_FACET = "productType:Jogos";

// O Algolia limita a janela de uma busca comum a ~1000 resultados. Para
// monitorar TODAS as promoções, o Worker consulta os facets do catálogo e
// divide a busca em partições disjuntas (preço/publicadora) com <= 1000 hits.
export const PARTITION_FACETS = ["priceRangeFilter", "softwarePublisher"] as const;
export const ALGOLIA_HITS_PER_PARTITION = 1000;
export const ALGOLIA_INITIAL_PAGE_SIZE = 500;
export const ALGOLIA_MIN_PAGE_SIZE = 50;
export const ALGOLIA_PARTITION_TARGET_HITS = 800;
export const ALGOLIA_MAX_FACET_VALUES = 1000;

export const PRICE_ENDPOINT = "https://api.ec.nintendo.com/v1/price";

// 1–3 jogos: notificação individual. 4+ jogos: uma notificação agrupada.
export const GROUP_NOTIFICATION_THRESHOLD = 4;
export const MAX_PRIORITY_NOTIFICATIONS_PER_RUN = 5;
export const MISSING_CYCLES_TO_DEACTIVATE = 2;
export const RECENT_EVENT_LIMIT = 10;
