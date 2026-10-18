import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { hitToRow, rowsFrom } from "../src/rows.js";
import type { AlgoliaHit } from "../src/algolia.js";

/**
 * The translation from CeX's own labels to the app's kind names, which is the
 * whole of what this service is allowed to decide. The rules pinned here were
 * each learned from a real failure.
 */

const base: AlgoliaHit = {
  objectID: "045496830144C",
  boxId: "045496830144C",
  boxName: "Super Mario Kart, Unboxed",
  categoryFriendlyName: "Super NES Software",
  sellPrice: 15,
  cashPriceCalculated: 6,
  exchangePriceCalculated: 9,
  boxBuyAllowed: 1,
  inStockOnline: 1,
};

describe("hitToRow", () => {
  it("maps CeX's three amounts onto the app's kind names", () => {
    const row = hitToRow(base, "GBP")!;
    expect(row).toMatchObject({
      sourceProductId: "045496830144C",
      title: "Super Mario Kart, Unboxed",
      categoryText: "Super NES Software",
      prices: { sell: 15, cash: 6, voucher: 9 },
      currency: "GBP",
      available: true,
    });
  });

  it("omits both buy kinds when CeX says it does not buy the title", () => {
    // MEASURED, not assumed: CeX sends a literal 0 in every price field for
    // every title, including one it will not buy, and never omits a key. Only
    // the flag can tell "pays nothing" from "does not buy", and a stored zero
    // is shown to a user as a real offer of GBP 0.00.
    const row = hitToRow(
      { ...base, boxBuyAllowed: 0, cashPriceCalculated: 0, exchangePriceCalculated: 0 },
      "GBP",
    )!;
    expect(row.prices).toEqual({ sell: 15 });
  });

  it("keeps a genuine zero that CeX really quotes", () => {
    // The other half of the same rule: with the flag saying the title IS
    // bought, a zero is a quote and the protocol wants it sent as one.
    const row = hitToRow({ ...base, cashPriceCalculated: 0 }, "GBP")!;
    expect(row.prices).toEqual({ sell: 15, cash: 0, voucher: 9 });
  });

  it("leaves the amounts alone when CeX sends no flag at all", () => {
    const { boxBuyAllowed: _flag, ...noFlag } = base;
    expect(hitToRow(noFlag, "GBP")!.prices).toEqual({ sell: 15, cash: 6, voucher: 9 });
  });

  it("drops a non-numeric amount instead of crashing or writing a zero", () => {
    // A real scar: `=== undefined` let a JSON null through to
    // null.toFixed and crashed a whole category sweep, and `(n ?? 0)` turned
    // both null and undefined into a wrong zero.
    const row = hitToRow(
      { ...base, cashPriceCalculated: null as unknown as number, exchangePriceCalculated: "9" as unknown as number },
      "GBP",
    )!;
    expect(row.prices).toEqual({ sell: 15 });
  });

  it("drops a hit with no storable price at all", () => {
    // A row with an empty `prices` object is refused by the protocol, and a
    // refusal costs the whole page rather than the one row.
    expect(
      hitToRow({ objectID: "A1", boxName: "Mystery box", boxBuyAllowed: 0 }, "GBP"),
    ).toBeNull();
  });

  it("never dates a row by when CeX last changed its price", () => {
    // That date read as the block's "updated" time: a price read today showed
    // as July 2024. The app dates the row by its own sweep instead.
    expect(hitToRow({ ...base, priceLastChanged: "2024-07-06 03:00:14" } as AlgoliaHit, "GBP")).not.toHaveProperty("observedAt");
  });

  it("reads availability from inStockOnline, and calls an absent flag unknown", () => {
    expect(hitToRow({ ...base, inStockOnline: 0 }, "GBP")!.available).toBe(false);
    const { inStockOnline: _absent, ...unknown } = base;
    expect(hitToRow(unknown, "GBP")!.available).toBeNull();
  });

  it("prefers boxId over objectID for the id the app stores", () => {
    // They are the same string in every fixture, and the app's stored mappings
    // are keyed on it, so the order matters more than the difference does.
    expect(hitToRow({ ...base, boxId: "OTHER" }, "GBP")!.sourceProductId).toBe("OTHER");
    const { boxId: _absent, ...noBoxId } = base;
    expect(hitToRow(noBoxId, "GBP")!.sourceProductId).toBe("045496830144C");
  });

  it("carries the country's own currency, which has no default", () => {
    expect(hitToRow(base, "EUR")!.currency).toBe("EUR");
  });
});

describe("rowsFrom", () => {
  it("deduplicates a page by id, last one winning", () => {
    const rows = rowsFrom([base, { ...base, sellPrice: 20 }], "GBP");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.prices.sell).toBe(20);
  });

  it("maps a real Algolia answer, saved from the live index", () => {
    // a real `prod_cex_uk` answer, not a hand-written one
    const fixture = JSON.parse(
      readFileSync(new URL("../fixtures/algolia-query-snes.json", import.meta.url), "utf8"),
    ) as { hits?: AlgoliaHit[]; results?: Array<{ hits: AlgoliaHit[] }> };
    const hits = fixture.hits ?? fixture.results?.[0]?.hits ?? [];
    expect(hits.length).toBeGreaterThan(0);
    const rows = rowsFrom(hits, "GBP");
    expect(rows).toHaveLength(hits.length);
    for (const row of rows) {
      expect(row.sourceProductId).not.toBe("");
      expect(row.title.length).toBeGreaterThan(0);
      expect(Object.keys(row.prices).length).toBeGreaterThan(0);
      expect(row.currency).toBe("GBP");
    }
  });
});
