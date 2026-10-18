import { describe, it, expect } from "vitest";
import type { AlgoliaAnswer, AlgoliaHit } from "../src/algolia.js";
import { decodeCursor, encodeCursor, fetchUnitPage } from "../src/units.js";

/**
 * The partition walk, which is the one genuinely new thing in this service.
 *
 * Algolia hands over at most 1,000 hits per query however it is paged, so a
 * category above that has to be asked for in half-open `sellPrice` ranges. The
 * walk lives in the protocol's cursor, so that each HTTP request makes EXACTLY ONE Algolia call —
 * the app paces every call to this service, and a call made inside a request is
 * a call it cannot pace.
 */

const hit = (id: string, sellPrice: number): AlgoliaHit => ({
  objectID: id,
  boxId: id,
  boxName: `Box ${id}`,
  categoryFriendlyName: "Super NES Software",
  sellPrice,
  inStockOnline: 1,
});

/** A query that answers from a script, and records what it was asked. */
function recorder(answers: AlgoliaAnswer[]) {
  const asked: Array<Record<string, unknown>> = [];
  let at = 0;
  return {
    asked,
    query: async (_index: string, body: Record<string, unknown>): Promise<AlgoliaAnswer> => {
      asked.push(body);
      const answer = answers[at];
      at += 1;
      if (answer === undefined) throw new Error("asked more times than the test scripted");
      return answer;
    },
  };
}

const page = (recorded: ReturnType<typeof recorder>, cursor?: string) =>
  fetchUnitPage({
    query: recorded.query,
    index: "prod_cex_uk",
    category: "Super NES Software",
    currency: "GBP",
    ...(cursor === undefined ? {} : { cursor }),
  });

describe("fetchUnitPage", () => {
  it("answers a category that fits in one query, and ends the unit", async () => {
    const recorded = recorder([{ nbHits: 2, hits: [hit("A1", 8), hit("A2", 15)] }]);
    const result = await page(recorded);
    expect(result).not.toBe("bad-cursor");
    if (result === "bad-cursor") return;
    expect(result.rows.map((row) => row.sourceProductId)).toEqual(["A1", "A2"]);
    expect(result.next).toBeNull();
    expect(result.complete).toBe(true);
    expect(result.notes).toBeUndefined();
    // ONE call, and no price filter on the first ask: the whole category.
    expect(recorded.asked).toHaveLength(1);
    expect(recorded.asked[0]!.numericFilters).toBeUndefined();
  });

  it("splits a category over the ceiling and asks the low half next", async () => {
    // THE RULE THIS FILE EXISTS FOR. The splitting page makes one call, keeps
    // no rows -- the thousand it got back are an arbitrary thousand of more
    // than a thousand -- and hands back a cursor. The next page asks about
    // [0, 50000) because the low half is popped first.
    const tooMany = recorder([{ nbHits: 4321, hits: Array.from({ length: 1000 }, (_, i) => hit(`A${i}`, 5)) }]);
    const split = await page(tooMany);
    if (split === "bad-cursor") throw new Error("unexpected bad cursor");
    expect(split.rows).toEqual([]);
    expect(split.complete).toBe(false);
    expect(split.next).not.toBeNull();
    expect(tooMany.asked).toHaveLength(1);

    const walk = decodeCursor(split.next!);
    expect(walk).not.toBeNull();
    // the open top half is still pending, the low half is next off the stack
    expect(walk!.ranges).toEqual([
      [50000, null],
      [0, 50000],
    ]);

    const low = recorder([{ nbHits: 1, hits: [hit("B1", 12)] }]);
    const second = await page(low, split.next!);
    if (second === "bad-cursor") throw new Error("unexpected bad cursor");
    expect(low.asked[0]!.numericFilters).toEqual(["sellPrice>=0", "sellPrice<50000"]);
    expect(second.rows.map((row) => row.sourceProductId)).toEqual(["B1"]);
    // one range still pending, so the unit is not over and is not complete
    expect(second.next).not.toBeNull();
    expect(second.complete).toBe(false);
  });

  it("reports a shortfall instead of claiming a complete sweep", async () => {
    // A thousand boxes at one price to the penny: the range cannot be halved
    // any further, so the rest are unreachable. Reporting `complete` here
    // would authorise the app to DELETE every row this sweep did not write --
    // including the ones it could not see.
    const stuck = recorder([{ nbHits: 1500, hits: Array.from({ length: 1000 }, (_, i) => hit(`A${i}`, 5)) }]);
    const result = await page(stuck, encodeCursor({ ranges: [[5, 5.005]], shortfall: 0 }));
    if (result === "bad-cursor") throw new Error("unexpected bad cursor");
    expect(result.rows).toHaveLength(1000);
    expect(result.next).toBeNull();
    expect(result.complete).toBe(false);
    expect(result.notes).toContain("500 hits unreachable");
  });

  it("carries a shortfall from an earlier page into the last one", async () => {
    // The flag is read off the LAST page only, so a shortfall that happened
    // three pages ago has to survive in the cursor or it is forgotten.
    const recorded = recorder([{ nbHits: 1, hits: [hit("A1", 8)] }]);
    const result = await page(recorded, encodeCursor({ ranges: [[0, null]], shortfall: 7 }));
    if (result === "bad-cursor") throw new Error("unexpected bad cursor");
    expect(result.next).toBeNull();
    expect(result.complete).toBe(false);
    expect(result.notes).toContain("7 hits unreachable");
  });

  it("refuses a cursor it did not issue rather than restarting the unit", async () => {
    // Restarting would sweep part of a category and let it be reported as the
    // whole of one, which is a deletion.
    const recorded = recorder([]);
    expect(await page(recorded, "not-a-cursor")).toBe("bad-cursor");
    expect(await page(recorded, encodeCursor({ ranges: [], shortfall: 0 }))).toBe("bad-cursor");
    expect(recorded.asked).toEqual([]);
  });

  it("round-trips a cursor and stays well inside the protocol's 512 characters", async () => {
    const deep = encodeCursor({
      ranges: Array.from({ length: 12 }, (_, i) => [i * 10, (i + 1) * 10] as [number, number]),
      shortfall: 3,
    });
    expect(deep.length).toBeLessThan(512);
    expect(decodeCursor(deep)?.shortfall).toBe(3);
    expect(decodeCursor(deep)?.ranges).toHaveLength(12);
  });
});
