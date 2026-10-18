/**
 * The one outbound call this service makes: a query against a CeX country's
 * Algolia index.
 *
 * No pacing, retry, cache or breaker here: the app holds one limiter and one
 * breaker per plugin, so the pace set in Settings → Plugins decides how hard
 * CeX is hit. The cost: a 429 becomes a failed page (the unit ends INCOMPLETE,
 * nothing is deleted) and the app's breaker holds the plugin off. ONE Algolia
 * call per HTTP request is therefore a rule: calls the app cannot see are
 * calls it cannot pace.
 */

// undici's fetch, not the global: only this one is MockAgent-interceptable,
// so tests exercise every path without reaching CeX.
import { fetch } from "undici";
import type { Settings } from "./config.js";

/** The fields this service asks for, and the only ones it maps. */
export interface AlgoliaHit {
  objectID: string;
  boxId?: string;
  boxName: string;
  categoryFriendlyName?: string;
  sellPrice?: number;
  cashPriceCalculated?: number;
  exchangePriceCalculated?: number;
  /** 0 = CeX does not buy this title; its buy prices then arrive as a literal 0 */
  boxBuyAllowed?: number;
  inStockOnline?: number;
  ecomQuantity?: number;
}

export interface AlgoliaAnswer {
  nbHits: number;
  hits: AlgoliaHit[];
}

/**
 * Asked for by name: a bare query answers every attribute plus
 * `_highlightResult`, most of the payload of a 1,000-hit page measured
 * against the app's `SIDECAR_SYNC_MAX_BYTES`.
 */
const ATTRIBUTES = [
  "objectID",
  "boxId",
  "boxName",
  "categoryFriendlyName",
  "sellPrice",
  "cashPriceCalculated",
  "exchangePriceCalculated",
  "boxBuyAllowed",
  "inStockOnline",
  "ecomQuantity",
];

/** (index, body) -> what Algolia answered. Injected everywhere, so tests never fetch. */
export type QueryFn = (index: string, body: Record<string, unknown>) => Promise<AlgoliaAnswer>;

/** the most one Algolia answer may weigh; 1000 hits of this index are a few MB */
const MAX_RESPONSE_CHARS = 16_000_000;

export function makeQuery(settings: Settings): QueryFn {
  return async (index, body) => {
    const res = await fetch(`${settings.searchHost}/1/indexes/${index}/query`, {
      method: "POST",
      headers: {
        "x-algolia-application-id": settings.appId ?? "",
        "x-algolia-api-key": settings.apiKey ?? "",
        "content-type": "application/json",
        // an unofficial endpoint may stop answering callers that do not look like a browser
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      },
      body: JSON.stringify({ attributesToRetrieve: ATTRIBUTES, ...body }),
      signal: AbortSignal.timeout(settings.timeoutMs),
      // a redirect would send CeX's key, which is not an Authorization header
      // and so is not stripped, to whatever host the redirect names
      redirect: "error",
    });
    if (res.status !== 200) {
      // including 429: a failed page, see the module note
      const text = (await res.text()).slice(0, 200);
      throw new Error(`algolia HTTP ${res.status}: ${text}`);
    }
    // bounded before parsing: a page is at most 1000 hits, well under this
    const text = await res.text();
    if (text.length > MAX_RESPONSE_CHARS) throw new Error(`algolia answered ${text.length} characters, more than the plugin accepts`);
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) throw new Error("algolia did not answer a JSON object");
    const { nbHits, hits } = parsed as { nbHits?: unknown; hits?: unknown };
    if (hits !== undefined && !Array.isArray(hits)) throw new Error("algolia's hits is not an array");
    if (nbHits !== undefined && typeof nbHits !== "number") throw new Error("algolia's nbHits is not a number");
    return { nbHits: nbHits ?? 0, hits: (hits ?? []) as AlgoliaHit[] };
  };
}

/** One category, optionally narrowed to a half-open `sellPrice` range. */
export function categoryBody(
  category: string,
  hitsPerPage: number,
  range?: { min: number; max: number | null },
): Record<string, unknown> {
  const numericFilters =
    range === undefined || (range.min === 0 && range.max === null)
      ? undefined
      : range.max === null
        ? [`sellPrice>=${range.min}`]
        : [`sellPrice>=${range.min}`, `sellPrice<${range.max}`];
  return {
    query: "",
    facetFilters: [[`categoryFriendlyName:${category}`]],
    hitsPerPage,
    ...(numericFilters === undefined ? {} : { numericFilters }),
  };
}

/**
 * The boxes the app named, in one query. `objectID` is filterable without
 * being declared (verified live 2026-09-17, 100 ids accepted), so the sweep and
 * the refresh share one wire format and cannot disagree about a price.
 */
export function refreshBody(ids: readonly string[]): Record<string, unknown> {
  return {
    query: "",
    filters: ids.map((id) => `objectID:${id}`).join(" OR "),
    hitsPerPage: ids.length,
  };
}
