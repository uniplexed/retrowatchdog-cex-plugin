import { describe, it, expect } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { AlgoliaAnswer, AlgoliaHit } from "../src/algolia.js";
import { loadSettings } from "../src/config.js";
import { healthPayload } from "../src/server.js";
import { scheduleFrom } from "../src/manifest.js";
import { makeHandler } from "../src/server.js";

/**
 * The HTTP surface, exercised over a real socket with a scripted Algolia.
 *
 * Nothing here reaches CeX: the query function is injected, exactly as the
 * eBay plugin's own server tests inject a search function.
 */

const settings = loadSettings({ PORT: "0", CEX_ALGOLIA_APP_ID: "APPID", CEX_ALGOLIA_API_KEY: "searchkey" });
const schedule = scheduleFrom({});

const hit = (id: string): AlgoliaHit => ({
  objectID: id,
  boxId: id,
  boxName: `Box ${id}`,
  categoryFriendlyName: "Super NES Software",
  sellPrice: 15,
  cashPriceCalculated: 6,
  exchangePriceCalculated: 9,
  boxBuyAllowed: 1,
  inStockOnline: 1,
});

interface Asked {
  index: string;
  body: Record<string, unknown>;
}

async function withServer(
  answer: (asked: Asked) => Promise<AlgoliaAnswer> | AlgoliaAnswer,
  run: (base: string, asked: Asked[]) => Promise<void>,
): Promise<void> {
  const asked: Asked[] = [];
  const server: Server = createServer(
    makeHandler({
      settings,
      schedule,
      query: async (index, body) => {
        asked.push({ index, body });
        return answer({ index, body });
      },
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`, asked);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const ok = (hits: AlgoliaHit[]): AlgoliaAnswer => ({ nbHits: hits.length, hits });

describe("the plugin's HTTP surface", () => {
  it("declares itself configured only when both halves of the Algolia pair are set", async () => {
    await withServer(() => ok([]), async (base) => {
      const res = await fetch(`${base}/health`);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ status: "ok", protocol: 3, configured: true });
    });
    const bare = loadSettings({ PORT: "0" });
    expect(bare.appId).toBeUndefined();
    expect(healthPayload(bare)).toMatchObject({ configured: false });
  });

  it("serves a manifest the app's own validator would accept", async () => {
    await withServer(() => ok([]), async (base) => {
      const body = (await (await fetch(`${base}/manifest`)).json()) as {
        protocol: number;
        plugin: { name: string };
        sources: Array<Record<string, unknown>>;
      };
      expect(body.protocol).toBe(3);
      expect(body.plugin.name).toBe("cex");
      expect(body.sources.map((source) => source.id)).toEqual(["cex", "cex_es", "cex_ie"]);
      // The ids do not move, and neither do the roles.
      expect(body.sources[0]).toMatchObject({
        kind: "sync",
        family: "cex",
        country: "GB",
        reach: "local",
        defaultRegion: "PAL",
        expectedCurrencies: ["GBP"],
        kindRoles: { sell: "buy_store", cash: "bid", voucher: "bid" },
        productUrl: "https://uk.webuy.com/product-detail?id={id}",
        schedule: { catalogCron: "0 3 * * 1", trackedRefreshHours: 24 },
      });
      expect(body.sources[1]).toMatchObject({
        country: "ES",
        expectedCurrencies: ["EUR"],
        productUrl: "https://es.webuy.com/product-detail?id={id}",
      });
    });
  });

  it("lists a country's own category names, not the UK's", async () => {
    await withServer(() => ok([]), async (base) => {
      const uk = (await (await fetch(`${base}/catalog/units?source=cex`)).json()) as string[];
      const es = (await (await fetch(`${base}/catalog/units?source=cex_es`)).json()) as string[];
      expect(uk).toContain("Super NES Software");
      expect(es).toContain("Super NES Juegos");
      // Ireland does not copy the UK, and Spain does not translate it: these
      // are verbatim facet strings, and a plausible guess matches nothing.
      expect(es).not.toContain("Super NES Software");
    });
  });

  it("sweeps one unit and hands back the protocol's three fields", async () => {
    await withServer(
      () => ok([hit("A1"), hit("A2")]),
      async (base, asked) => {
        const res = await fetch(
          `${base}/catalog/units/${encodeURIComponent("Super NES Software")}?source=cex`,
        );
        expect(res.status).toBe(200);
        const page = (await res.json()) as { rows: unknown[]; next: null; complete: boolean };
        expect(page.rows).toHaveLength(2);
        expect(page.next).toBeNull();
        expect(page.complete).toBe(true);
        expect(asked).toHaveLength(1);
        expect(asked[0]!.index).toBe("prod_cex_uk");
      },
    );
  });

  it("decodes a unit whose name the URL had to encode", async () => {
    // "Game & Watch" and "GBA Juegos" are real category names; a unit that
    // arrived still encoded would match no category and sweep nothing.
    await withServer(
      () => ok([hit("A1")]),
      async (base, asked) => {
        const res = await fetch(
          `${base}/catalog/units/${encodeURIComponent("Game & Watch")}?source=cex`,
        );
        expect(res.status).toBe(200);
        expect(asked[0]!.body.facetFilters).toEqual([["categoryFriendlyName:Game & Watch"]]);
      },
    );
  });

  it("refuses a unit this shop does not sweep", async () => {
    await withServer(() => ok([]), async (base, asked) => {
      const res = await fetch(`${base}/catalog/units/Furniture?source=cex`);
      expect(res.status).toBe(404);
      expect(asked).toEqual([]);
    });
  });

  it("answers 502 when CeX does, so the unit ends incomplete and nothing is deleted", async () => {
    // Includes a 429. The app's breaker is what holds this plugin off after
    // it; this process has no opinion about how hard CeX may be hit.
    await withServer(
      () => {
        throw new Error("algolia HTTP 429: too many requests");
      },
      async (base) => {
        const res = await fetch(
          `${base}/catalog/units/${encodeURIComponent("Super NES Software")}?source=cex`,
        );
        expect(res.status).toBe(502);
        expect((await res.json()) as { error: string }).toMatchObject({
          error: expect.stringContaining("429") as unknown as string,
        });
      },
    );
  });

  it("refreshes the boxes the app named, in one query", async () => {
    // The measurement this service is built on: one filter expression asks
    // for many ids.
    await withServer(
      ({ body }) => {
        const filters = String(body.filters);
        return ok(
          ["045496830144C", "045496330347C"].filter((id) => filters.includes(id)).map((id) => hit(id)),
        );
      },
      async (base, asked) => {
        const res = await fetch(`${base}/catalog/refresh`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ source: "cex", ids: ["045496830144C", "045496330347C", "GONE"] }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { rows: Array<{ sourceProductId: string }> };
        // The id CeX did not answer for is simply absent, which the protocol
        // reads as "delisted or unknown, leave the stored row alone".
        expect(body.rows.map((row) => row.sourceProductId)).toEqual([
          "045496830144C",
          "045496330347C",
        ]);
        expect(asked).toHaveLength(1);
        expect(String(asked[0]!.body.filters)).toContain("objectID:045496830144C OR");
      },
    );
  });

  it("splits a refresh that names more ids than one filter should carry", async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `ID${i}`);
    await withServer(
      () => ok([]),
      async (base, asked) => {
        await fetch(`${base}/catalog/refresh`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ source: "cex", ids }),
        });
        // 100 per query by default: the length measured live, not a guess.
        expect(asked).toHaveLength(2);
        expect(String(asked[0]!.body.filters).split(" OR ")).toHaveLength(100);
        expect(String(asked[1]!.body.filters).split(" OR ")).toHaveLength(50);
      },
    );
  });

  it("refuses a request that names a source this plugin does not serve", async () => {
    await withServer(() => ok([]), async (base) => {
      expect((await fetch(`${base}/catalog/units?source=cex_fr`)).status).toBe(404);
      expect((await fetch(`${base}/catalog/units`)).status).toBe(400);
      const res = await fetch(`${base}/catalog/refresh`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: "cex", ids: [""] }),
      });
      expect(res.status).toBe(400);
    });
  });

  it("answers JSON on a method and a path it does not serve", async () => {
    // Never an empty body: the app stores what it reads here as the plugin's
    // last error, which is where an operator finds out what happened.
    await withServer(() => ok([]), async (base) => {
      const put = await fetch(`${base}/manifest`, { method: "PUT" });
      expect(put.status).toBe(404);
      expect(await put.json()).toMatchObject({ error: expect.stringContaining("PUT") as unknown as string });
      const missing = await fetch(`${base}/search?q=zelda`);
      expect(missing.status).toBe(404);
      expect(await missing.json()).toMatchObject({
        error: expect.stringContaining("/search") as unknown as string,
      });
    });
  });
});
