/**
 * One Algolia hit turned into one protocol catalog row (the protocol
 * document, `docs/sidecar-protocol.md` in the `retrowatchdog` repository, §4). The plugin fetches and never classifies: no platform, region, condition
 * or grade — the app reads those, and a row that claimed one would be refused.
 */

import type { AlgoliaHit } from "./algolia.js";

/** A protocol catalog row, as §4's table defines it. */
export interface CatalogRow {
  sourceProductId: string;
  title: string;
  categoryText?: string;
  /** keyed by the APP's kind names; amounts are numbers on the wire */
  prices: Record<string, number>;
  currency: string;
  available: boolean | null;
}

/**
 * One quoted amount, or nothing. Guarded on the TYPE because the response is
 * not runtime-validated: a JSON `null` once reached `null.toFixed` and crashed
 * a whole sweep. Rounded to two decimals to match the app's `numeric(10, 2)`.
 */
const money = (value: unknown): number | undefined =>
  typeof value !== "number" || !Number.isFinite(value) || value < 0
    ? undefined
    : Math.round(value * 100) / 100;

/**
 * Cash and voucher, or nothing when CeX does not buy the title. CeX sends a
 * literal `0` in every price field even for titles it will not buy
 * (fixtures/absent-vs-zero-price-fields-2026-09-09.md), so `boxBuyAllowed: 0`
 * is the only signal; an absent flag leaves the amounts alone.
 */
function buyPrices(hit: AlgoliaHit): Record<string, number | undefined> {
  return hit.boxBuyAllowed === 0
    ? {}
    : { cash: hit.cashPriceCalculated, voucher: hit.exchangePriceCalculated };
}

/**
 * `currency` has no default on purpose: it is a fact about the country, and a
 * default would silently publish EUR amounts as GBP. A hit with no storable
 * price yields null, since an empty `prices` object costs the whole page.
 */
export function hitToRow(hit: AlgoliaHit, currency: string): CatalogRow | null {
  const amounts: Record<string, number | undefined> = { sell: hit.sellPrice, ...buyPrices(hit) };
  const prices: Record<string, number> = {};
  for (const [kind, amount] of Object.entries(amounts)) {
    const value = money(amount);
    if (value !== undefined) prices[kind] = value;
  }
  if (Object.keys(prices).length === 0) return null;
  const id = hit.boxId ?? hit.objectID;
  if (typeof id !== "string" || id.length === 0 || typeof hit.boxName !== "string") return null;
  return {
    sourceProductId: id,
    title: hit.boxName,
    ...(typeof hit.categoryFriendlyName === "string"
      ? { categoryText: hit.categoryFriendlyName }
      : {}),
    prices,
    currency,
    // `outOfStock` is an array of store names; `inStockOnline` is the flag, absent = unknown
    available: hit.inStockOnline === undefined ? null : hit.inStockOnline === 1,
    // No `observedAt`: CeX's `priceLastChanged` says when the price last MOVED,
    // not when CeX reported it, and the app would show it as the block's
    // "updated" time. Omitted, the app dates the row by its own sweep.
  };
}

/** Rows for one page, deduplicated by id here (last wins) rather than by chunk boundary app-side. */
export function rowsFrom(hits: readonly AlgoliaHit[], currency: string): CatalogRow[] {
  const byId = new Map<string, CatalogRow>();
  for (const hit of hits) {
    const row = hitToRow(hit, currency);
    if (row !== null) byId.set(row.sourceProductId, row);
  }
  return [...byId.values()];
}
