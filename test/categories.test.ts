import { describe, expect, it } from "vitest";
import { loadSettings, shopById } from "../src/config.js";

/**
 * The category lists this plugin sweeps, against the live facet strings they
 * were copied from (`fixtures/country-categories-2026-09-03.md`).
 *
 * Hand-transcribed on purpose: deriving the table from `src/config.ts` — the
 * lists under test — would make it unable to fail. Every string below is a
 * `categoryFriendlyName` a live Algolia facet query returned, never a
 * transformation of the UK's name, and that is the whole point: a plausible
 * guess matches nothing at all, silently, and a category that matches nothing
 * reads exactly like a category the shop emptied.
 *
 * That every one of these strings resolves to the right platform is the
 * app's reading, pinned in the app repository,
 * `apps/api/test/adapters/familyReading.test.ts`.
 */
const FIXTURE: ReadonlyArray<{
  console: string;
  cex: readonly string[];
  cex_es: readonly string[];
  cex_ie: readonly string[];
}> = [
  { console: "nes", cex: ["NES Software"], cex_es: ["NES Juegos"], cex_ie: ["NES Software"] },
  { console: "snes", cex: ["Super NES Software"], cex_es: ["Super NES Juegos"], cex_ie: ["Super NES Software"] },
  { console: "n64", cex: ["Nintendo 64 Software"], cex_es: ["Nintendo 64 Juegos"], cex_ie: ["Nintendo 64 Software"] },
  { console: "gb", cex: ["Game Boy Software"], cex_es: ["Game Boy Juegos"], cex_ie: ["Game Boy Software"] },
  { console: "gbc", cex: ["Game Boy Color Software"], cex_es: ["Game Boy Color Juegos"], cex_ie: ["Game Boy Color Software"] },
  { console: "gba", cex: ["Gameboy Advance Software"], cex_es: ["GBA Juegos"], cex_ie: ["Gameboy Advance Software"] },
  // two categories in the UK and Ireland, one in Spain: the sweep takes both
  // where they exist (the UK's "Rarities" held 183 live boxes that were
  // invisible to the app while the line was missing)
  { console: "gamecube", cex: ["GameCube Games", "GameCube Rarities"], cex_es: ["Gamecube Juegos"], cex_ie: ["GameCube Games", "GameCube Rarities"] },
  { console: "ds", cex: ["Nintendo DS Games"], cex_es: ["DS Juegos"], cex_ie: ["Nintendo DS Games"] },
  { console: "3ds", cex: ["3DS Games"], cex_es: ["3DS Juegos"], cex_ie: ["3DS Games"] },
  { console: "megadrive", cex: ["Mega Drive Software"], cex_es: ["Mega Drive Juegos"], cex_ie: ["Mega Drive Software"] },
  { console: "master_system", cex: ["Master System Software"], cex_es: ["Master System Juegos"], cex_ie: ["Master System Software"] },
  { console: "game_gear", cex: ["Game Gear Games"], cex_es: ["Game Gear Juegos"], cex_ie: ["Game Gear Software"] },
  { console: "saturn", cex: ["Sega Saturn Games"], cex_es: ["Sega Saturn Juegos"], cex_ie: ["Sega Saturn Software"] },
  { console: "dreamcast", cex: ["Dreamcast Games"], cex_es: ["Dreamcast Juegos"], cex_ie: ["Dreamcast Software"] },
  { console: "ps1", cex: ["Playstation1 Games"], cex_es: ["PS1 Juegos"], cex_ie: ["Playstation1 Software"] },
  { console: "ps2", cex: ["Playstation2 Games"], cex_es: ["Playstation2 Juegos"], cex_ie: ["Playstation2 Games"] },
  // no ES or IE category exists for either: a shorter list is the honest
  // outcome, not an incomplete one
  { console: "virtual_boy", cex: ["Virtual Boy Software"], cex_es: [], cex_ie: [] },
  { console: "neogeo_pocket_color", cex: ["Neo Geo Pocket Color Software"], cex_es: [], cex_ie: [] },
  // live facet query 2026-10-18: the UK keeps its older discs in "PC CD-ROM"
  { console: "pc", cex: ["PC Games", "PC CD-ROM"], cex_es: ["PC Juegos"], cex_ie: ["PC Games"] },
];

/**
 * Categories a shop sweeps that the fixture's table does not cover, with the
 * evidence that put them there. The table enumerates only the consoles that
 * facet query measured; a string missing from it is not evidence of absence.
 */
const OUTSIDE_THE_TABLE: Record<CexId, readonly string[]> = {
  // verified live 2026-09-01: the category really is just "Game & Watch", with
  // no Games/Software suffix. The 2026-09-03 fixture does not measure this
  // console in any country, so no ES or IE claim is made.
  cex: ["Game & Watch"],
  cex_es: [],
  cex_ie: [],
};

type CexId = "cex" | "cex_es" | "cex_ie";
const SHOPS: readonly CexId[] = ["cex", "cex_es", "cex_ie"];

const settings = loadSettings({});
const categories = (id: CexId): readonly string[] => shopById(settings, id)!.categories;
const fromFixture = (id: CexId): string[] => FIXTURE.flatMap((row) => [...row[id]]);

describe("the categories each country is swept in", () => {
  it.each(SHOPS)("%s sweeps exactly the fixture's categories for its country", (id) => {
    expect([...categories(id)].sort()).toEqual(
      [...fromFixture(id), ...OUTSIDE_THE_TABLE[id]].sort(),
    );
  });

  it.each(SHOPS)("%s lists no category twice", (id) => {
    // A unit swept twice has its first pass's rows judged unseen and DELETED by
    // the second, so the app refuses a duplicated unit outright.
    expect(new Set(categories(id)).size).toBe(categories(id).length);
  });

  it("does not sweep the Atari Lynx category the fixture records", () => {
    // Real (288 UK records) and deliberately absent: the app has no
    // `atari_lynx` platform, so nothing could read a box swept from it. Adding
    // the console is an app change, documented in the app repository,
    // `packages/shared/src/platforms.ts`.
    for (const id of SHOPS) expect(categories(id)).not.toContain("Atari Lynx Software");
  });

  it("does not sweep the digital DS Ware category", () => {
    // DSiWare/eShop titles, mixed DS and 3DS, no physical cartridge. Owner
    // scope decision: physical carts only.
    for (const id of SHOPS) expect(categories(id)).not.toContain("DS Ware");
  });

  it("keeps Spain's and Ireland's lists shorter than the UK's, not incomplete", () => {
    expect(categories("cex_es").length).toBeLessThan(categories("cex").length);
    expect(categories("cex_ie").length).toBeLessThan(categories("cex").length);
    for (const id of ["cex_es", "cex_ie"] as const) {
      expect(categories(id)).not.toContain("Virtual Boy Software");
      expect(categories(id)).not.toContain("Neo Geo Pocket Color Software");
    }
  });

  it("lets a deployment narrow a list without touching the others", () => {
    // A value REPLACES its default wholesale: the boxes it drops go stale and
    // are swept. It never extends the compiled list.
    const narrowed = loadSettings({ CEX_ES_CATEGORIES: "Super NES Juegos, 3DS Juegos" });
    expect(shopById(narrowed, "cex_es")!.categories).toEqual(["Super NES Juegos", "3DS Juegos"]);
    expect(shopById(narrowed, "cex")!.categories).toEqual(categories("cex"));
  });
});
