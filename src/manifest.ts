/**
 * What this plugin declares about itself: a PROPOSAL the app validates and a
 * person approves in Settings → Plugins before any price is stored.
 *
 * The ids `cex`, `cex_es`, `cex_ie` must never change: stored mappings,
 * catalogue rows and price history are keyed by them.
 *
 * `reach: "local"`: a shelf price is for that exact region and completeness.
 * `defaultRegion: "PAL"`: every CeX country here is PAL; the app applies it
 * only where a title declares no region.
 */

import type { Settings, Shop } from "./config.js";

export const PROTOCOL_VERSION = 3;
export const PLUGIN_NAME = "cex";
export const PLUGIN_VERSION = "1.0.0";

/** The cadence this plugin asks for, overridable per deployment. */
export interface Schedule {
  readonly catalogCron: string;
  readonly trackedRefreshHours: number;
}

export function scheduleFrom(env: NodeJS.ProcessEnv = process.env): Schedule {
  const hours = Number.parseInt(env.CEX_TRACKED_REFRESH_HOURS ?? "", 10);
  return {
    // Weekly, Monday 03:00, after a shop's overnight repricing has landed: a
    // full-catalogue sweep is a systematic read of CeX's database, so it runs
    // as rarely as the prices allow; the titles you follow refresh daily below.
    catalogCron: env.CEX_SYNC_CRON ?? "0 3 * * 1",
    // 1..168 is the app's bound; fall back rather than propose a manifest it refuses
    trackedRefreshHours: Number.isInteger(hours) && hours >= 1 && hours <= 168 ? hours : 24,
  };
}

function sourceFor(shop: Shop, schedule: Schedule): Record<string, unknown> {
  return {
    id: shop.id,
    kind: "sync",
    label: shop.label,
    family: "cex",
    familyLabel: "CeX",
    country: shop.country,
    reach: "local",
    // never absent: the validator refuses a MISSING defaultRegion
    defaultRegion: "PAL",
    expectedCurrencies: [shop.currency],
    kindRoles: { sell: "buy_store", cash: "bid", voucher: "bid" },
    // labels name the SHOP, so a bark says which country quoted the price
    kindLabels: {
      sell: `${shop.label} sells for`,
      cash: `${shop.label} pays cash`,
      voucher: `${shop.label} pays voucher`,
    },
    caveat: `${shop.label} is read through CeX's unofficial search index, best-effort; it may stop working at any time.`,
    // No `sellFeeRate`: selling to CeX is over the counter, no fee (absent means 0).
    // No `categoryPlatforms`: the app's family reading already maps CeX categories.
    productUrl: `https://${shop.storefront}/product-detail?id={id}`,
    schedule: { catalogCron: schedule.catalogCron, trackedRefreshHours: schedule.trackedRefreshHours },
  };
}

export function manifestPayload(settings: Settings, schedule: Schedule): Record<string, unknown> {
  return {
    protocol: PROTOCOL_VERSION,
    plugin: { name: PLUGIN_NAME, version: PLUGIN_VERSION },
    requiredSecrets: ["CEX_ALGOLIA_APP_ID", "CEX_ALGOLIA_API_KEY"],
    sources: settings.shops.map((shop) => sourceFor(shop, schedule)),
  };
}
