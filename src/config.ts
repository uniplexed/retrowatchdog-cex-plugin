/**
 * Environment, read ONCE at boot, and the three shops this process can sweep.
 * No credential: CeX's Algolia app id and search key are public (its own
 * website ships them), so this container holds nothing worth stealing.
 */

/** The facts one CeX country fixes, and the app must be told. */
export interface Shop {
  /** the app's source id */
  readonly id: string;
  /** the country's Algolia index, e.g. prod_cex_es */
  readonly index: string;
  /** ISO 3166-1 alpha-2 */
  readonly country: string;
  /** what this country's shop quotes; the app drops a row quoted in anything else */
  readonly currency: string;
  /** the host that serves product pages, e.g. es.webuy.com */
  readonly storefront: string;
  /** the heading a user reads above these prices */
  readonly label: string;
  /** exact `categoryFriendlyName` values to sweep, from the live facet list */
  readonly categories: readonly string[];
}

/**
 * The UK's retro categories. Each MUST be a verbatim live facet string: a
 * guess matches nothing, silently. Widen with CEX_UK_CATEGORIES.
 */
const UK_CATEGORIES = [
  "Super NES Software",
  "Game Boy Software",
  "Game Boy Color Software",
  "Mega Drive Software",
  "Playstation1 Games",
  "NES Software",
  "Nintendo 64 Software",
  "GameCube Games",
  // the UK's SECOND GameCube category: 183 live boxes (facet query 2026-09-03)
  "GameCube Rarities",
  "Gameboy Advance Software",
  "Master System Software",
  "Game Gear Games",
  "Sega Saturn Games",
  "Dreamcast Games",
  "Playstation2 Games",
  // Neo Geo AES is not a CeX category at all; the Pocket Color is.
  "Neo Geo Pocket Color Software",
  // Physical carts only: "DS Ware" (digital DSiWare/eShop titles) is excluded.
  "Nintendo DS Games",
  "3DS Games",
  "Virtual Boy Software",
  // CeX does not split hardware from software here
  "Game & Watch",
  // PC (facet query 2026-10-18): "PC CD-ROM" holds the older discs
  "PC Games",
  "PC CD-ROM",
];

/**
 * Spain's, verbatim ("Juegos", "Gamecube", "GBA"). Virtual Boy, Neo Geo Pocket
 * Color and Atari Lynx were measured absent; Game & Watch was never measured.
 */
const ES_CATEGORIES = [
  "Super NES Juegos",
  "Game Boy Juegos",
  "Game Boy Color Juegos",
  "GBA Juegos",
  "Mega Drive Juegos",
  "PS1 Juegos",
  "NES Juegos",
  "Nintendo 64 Juegos",
  "Gamecube Juegos",
  "Master System Juegos",
  "Game Gear Juegos",
  "Sega Saturn Juegos",
  "Dreamcast Juegos",
  "Playstation2 Juegos",
  "DS Juegos",
  "3DS Juegos",
  "PC Juegos",
];

/** Ireland's, verbatim: English, but NOT the UK's (several are "Software" where the UK says "Games"). */
const IE_CATEGORIES = [
  "Super NES Software",
  "Game Boy Software",
  "Game Boy Color Software",
  "Gameboy Advance Software",
  "Mega Drive Software",
  "Playstation1 Software",
  "NES Software",
  "Nintendo 64 Software",
  "GameCube Games",
  "GameCube Rarities",
  "Master System Software",
  "Game Gear Software",
  "Sega Saturn Software",
  "Dreamcast Software",
  "Playstation2 Games",
  "Nintendo DS Games",
  "3DS Games",
  "PC Games",
];

export interface Settings {
  readonly port: number;
  readonly shops: readonly Shop[];
  /** CeX's Algolia application id and search-only key; undefined until the operator sets them */
  readonly appId: string | undefined;
  readonly apiKey: string | undefined;
  /** the Algolia search host, overridable so a test can point somewhere else */
  readonly searchHost: string;
  /**
   * Box ids per Algolia refresh query. Configurable because it rests on an
   * undocumented tolerance: a 100-id filter (2,694 chars) was accepted live
   * on 2026-09-17; nothing longer was measured.
   */
  readonly idsPerQuery: number;
  /** how long one outbound Algolia call may take, inside the app's own budget */
  readonly timeoutMs: number;
}

const list = (value: string | undefined, fallback: readonly string[]): readonly string[] =>
  value === undefined
    ? fallback
    : value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);

const int = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export function loadSettings(env: NodeJS.ProcessEnv = process.env): Settings {
  return {
    port: int(env.PORT, 8000),
    // always all three: the app's enabled-markets setting decides which are swept
    shops: [
      {
        id: "cex",
        index: env.CEX_UK_INDEX ?? "prod_cex_uk",
        country: "GB",
        currency: "GBP",
        storefront: "uk.webuy.com",
        label: "CeX UK",
        categories: list(env.CEX_UK_CATEGORIES, UK_CATEGORIES),
      },
      {
        id: "cex_es",
        index: env.CEX_ES_INDEX ?? "prod_cex_es",
        country: "ES",
        currency: "EUR",
        // UNVERIFIED: a wrong host only breaks product links, never a price
        storefront: "es.webuy.com",
        label: "CeX ES",
        categories: list(env.CEX_ES_CATEGORIES, ES_CATEGORIES),
      },
      {
        id: "cex_ie",
        index: env.CEX_IE_INDEX ?? "prod_cex_ie",
        country: "IE",
        currency: "EUR",
        storefront: "ie.webuy.com",
        label: "CeX IE",
        categories: list(env.CEX_IE_CATEGORIES, IE_CATEGORIES),
      },
    ],
    // No default: the pair is CeX's, read off its own website by whoever runs
    // this plugin (README, "Getting the Algolia key"). Missing means /health
    // says configured: false and the app never enables the shops.
    appId: env.CEX_ALGOLIA_APP_ID || undefined,
    apiKey: env.CEX_ALGOLIA_API_KEY || undefined,
    searchHost: env.CEX_ALGOLIA_HOST ?? "https://search.webuy.io",
    idsPerQuery: int(env.CEX_IDS_PER_QUERY, 100),
    // under the app's own 8000 ms timeout, or nobody reads the result
    timeoutMs: int(env.CEX_TIMEOUT_MS, 6000),
  };
}

export function shopById(settings: Settings, id: string): Shop | undefined {
  return settings.shops.find((shop) => shop.id === id);
}
