# CeX plugin

A source plugin for [RetroWatchdog](https://github.com/uniplexed/retrowatchdog),
the manager of your retro game collection and your price hunts. It sweeps
CeX's catalogue so the app can price your copies and your watches at CeX,
speaking protocol version 3 as set out in the protocol document,
`docs/sidecar-protocol.md` in the `retrowatchdog` repository. It serves three
`sync` sources, `cex` (UK), `cex_es` and `cex_ie`, and nothing else. In a
RetroWatchdog deployment it runs as the compose service `cex-plugin` behind
the `cex` profile, from the image `CEX_PLUGIN_IMAGE` names
(`retrowatchdog-cex-plugin:latest` by default), and the app offers it as a
pending plugin row on first boot from `CEX_PLUGIN_URL`
(`http://cex-plugin:8000`); you approve its roles in Settings → Plugins and
switch its markets on in Settings → Markets. Nothing about it is compiled into
the app.

The general rules (what a plugin is, the fetch/interpret split, the manifest
and its approval, the isolation, the pacing) are in the protocol document;
this file covers only what this plugin does within them.

It runs as its own container because CeX's Algolia index is an unofficial
API. A process of its own is a quarantine; an adapter inside the API process
is not.

## Legal notes: read before you run it

- CeX's [terms and conditions](https://uk.webuy.com/site/terms) (UK, ES and IE, checked
  2026-10-18) say nothing about automated access. They do say every content
  of the site is CeX's property, protected by copyright.
- The search key this plugin needs is CeX's own: its website hands it to every
  visitor's browser, and nothing from CeX says a program of your own may use
  it. Ask CeX if you want to be sure.
- A nightly sweep of a whole catalogue is a systematic extraction of a
  database. In the UK and the EU a database is protected by a database right
  of its own, independent of what the terms say, and extracting a substantial
  part of it without permission can infringe that right. Nothing in this
  repository resolves that question: keep the plugin to your own use, keep
  its pace slow, or ask CeX for permission.
- This is not legal advice. If you run this plugin for anything beyond your
  own collection, ask a lawyer first.

## What it serves

| endpoint | answer |
|---|---|
| `GET /health` | `{status, protocol, configured, shops}`. `configured` is `true` only when both `CEX_ALGOLIA_APP_ID` and `CEX_ALGOLIA_API_KEY` are set. `shops` is for humans; the app ignores it. |
| `GET /manifest` | the three sources with their roles, labels, product-URL templates and schedule |
| `GET /catalog/units?source=<id>` | that country's category names, verbatim facet strings |
| `GET /catalog/units/<unit>?source=<id>[&cursor=<c>]` | one page of one category |
| `POST /catalog/refresh` | `{rows}` for the box ids in the body, `{source, ids}` |

There is no `GET /search`. A sync source's game view is answered from the
app's own `catalog_items`, so the protocol gives a sync plugin no search
endpoint.

Status codes: `400` for a missing `source`, a body that is not a JSON object,
`ids` that are not non-empty strings, or a cursor this plugin did not issue;
`404` for a source this process does not serve, a unit the shop does not
sweep, or an unknown path; `502` when the Algolia call fails, a `429`
included; `500` for a bug in this process. A request body is read up to
64 KiB.

## What it leaves to the app

The protocol's general rules apply unchanged: the plugin fetches and never
classifies (the app reads platform, region, condition and grade from `title`
and `categoryText`), the app holds one rate limiter and one circuit breaker
per plugin and paces every call to these endpoints through them, and the
container holds no database, volume or published host port and sits on the
`sidecars` network only. Three things are specific to this plugin:

- One Algolia call per page request, because a call made inside a request is
  one the app cannot pace, count or hold off, and a page has the app's
  `ADAPTER_TIMEOUT_MS` (8 s) to answer in. A refresh makes one call per chunk
  of `CEX_IDS_PER_QUERY` ids. A `429` is a failed page: the unit ends
  incomplete, nothing is deleted, and the app's breaker holds the plugin off.
- No secret. The Algolia app id and search key it needs are the public pair
  CeX's site ships to every browser; see "Getting the Algolia key".
- No `observedAt`. CeX's `priceLastChanged` says when a price last moved, not
  when CeX reported it, so a CeX block's time is the sweep's.

## What it declares

Every source: `kind: sync`, `family: cex`, `reach: local` (a shelf price is
for that exact region and completeness), `defaultRegion: PAL` (applied only
where a title declares no region), one expected currency (GBP for `cex`, EUR
for `cex_es` and `cex_ie`), `kindRoles` `sell → buy_store`, `cash → bid` and
`voucher → bid`, `kindLabels` naming the shop ("CeX UK sells for", "CeX UK
pays cash", "CeX UK pays voucher"), a `productUrl` of
`https://<storefront>/product-detail?id={id}`, and a `schedule` of
`catalogCron` and `trackedRefreshHours`. The storefronts are `uk.webuy.com`,
`es.webuy.com` and `ie.webuy.com`; the Spanish host is unverified, and a wrong
one only breaks product links. No `requiredSecrets`, no `sellFeeRate` (selling
to CeX over the counter has no fee) and no `categoryPlatforms` (the app's
family reading maps CeX categories). The ids `cex`, `cex_es` and `cex_ie` must
never change: stored mappings, catalogue rows and price history are keyed by
them.

The app schedules from the approved manifest (protocol §6), so changing the
cadence needs a re-approval in Settings → Plugins.

## How a category is swept

Algolia returns at most 1,000 hits for one query. A category above that is
asked for in half-open `sellPrice` ranges `[min, max)`, with no gaps and no
double counts. The pending ranges travel in the protocol `cursor` (base64url
of compact JSON, `src/units.ts`), so every page is exactly one Algolia call.

- The first page asks for the whole category with `hitsPerPage: 1000`. When
  `nbHits` fits, the page carries the rows and the unit is complete.
- When it does not, the range is halved (an open top is bounded at 100,000
  first), both halves go onto the cursor and the page answers zero rows with a
  `next` cursor. The low half is popped first, so runs are deterministic.
- A range narrower than 0.01 that still exceeds 1,000 hits cannot be split:
  its first 1,000 rows are kept and the rest counted as shortfall, reported in
  `notes` as "N hits unreachable past Algolia's 1000-hit retrieval ceiling".
- `complete` is `true` only when the walk finished with no shortfall. The app
  deletes every stored row of a complete unit that the run did not write, so a
  partial sweep is never reported complete, and a cursor this plugin did not
  issue is a `400`, never a restart.

The refresh filters by `objectID` in one query per chunk of
`CEX_IDS_PER_QUERY` ids; the app hands up to 200 per call. An id CeX does not
answer is absent from `rows`, and the app leaves that row alone. The sweep and
the refresh share one wire format, so they cannot disagree about a price.
Measured on 2026-09-17: one query filtered by `objectID` returns every field
the sweep reads, and a filter naming 100 ids (2,694 characters) was accepted;
nothing longer was measured.

Requests carry a browser `user-agent`, because an unofficial endpoint may stop
answering callers that do not look like one. They ask for the ten attributes
the mapping reads by name: a bare query answers every attribute plus
`_highlightResult`, most of a 1,000-hit page's bytes against the app's
`SIDECAR_SYNC_MAX_BYTES`.

## How a row is built

`src/rows.ts` turns one Algolia hit into one catalog row (protocol §4).

| Algolia field | row field | rule |
|---|---|---|
| `boxId`, else `objectID` | `sourceProductId` | must be a non-empty string |
| `boxName` | `title` | verbatim |
| `categoryFriendlyName` | `categoryText` | verbatim when present |
| `sellPrice` | `prices.sell` | |
| `cashPriceCalculated` | `prices.cash` | omitted when `boxBuyAllowed` is `0` |
| `exchangePriceCalculated` | `prices.voucher` | omitted when `boxBuyAllowed` is `0` |
| `inStockOnline` | `available` | `1` reads `true`, `0` reads `false`, absent reads `null` |
| (nothing) | `currency` | the shop's, passed in; never defaulted, since a default would publish EUR amounts as GBP |

An amount is kept only when it is a finite non-negative number, rounded to two
decimals to match the app's `numeric(10, 2)`. A hit with no storable price
yields no row, because an empty `prices` object costs the whole page. Within
one page rows are deduplicated by id, last wins.

The `boxBuyAllowed` gate is the one judgement this plugin makes. The protocol
asks a plugin to omit a kind its source does not quote, and CeX's wire format
sends a literal `0` in every price field for every title, including one it
will not buy, and never omits a key. `boxBuyAllowed: 0` is the only signal
that a title is not bought; without the gate a shop "paying £0.00" would be
stored and shown as a real offer. An absent flag leaves the amounts alone.

## Configuration

`.env.example` documents every variable. Only the Algolia pair is required;
everything else has a compiled default. In a RetroWatchdog deployment the
plugin's environment is `.env.cex`, beside the app's `.env`, which compose
reads with `required: false`.

| variable | default | meaning |
|---|---|---|
| `PORT` | `8000` | the port inside the container |
| `CEX_UK_CATEGORIES`, `CEX_ES_CATEGORIES`, `CEX_IE_CATEGORIES` | the lists in `src/config.ts` | comma-separated verbatim `categoryFriendlyName` facet strings to sweep |
| `CEX_UK_INDEX`, `CEX_ES_INDEX`, `CEX_IE_INDEX` | `prod_cex_uk`, `prod_cex_es`, `prod_cex_ie` | the Algolia index per country |
| `CEX_ALGOLIA_APP_ID` | none, required | CeX's Algolia application id; see "Getting the Algolia key" |
| `CEX_ALGOLIA_API_KEY` | none, required | CeX's search-only key; see "Getting the Algolia key" |
| `CEX_ALGOLIA_HOST` | `https://search.webuy.io` | the search host |
| `CEX_SYNC_CRON` | `0 3 * * 1` | the sweep cadence the manifest proposes: weekly, Monday 03:00. A daily sweep (`0 3 * * *`) reads CeX's whole catalogue every night; keep it rare |
| `CEX_TRACKED_REFRESH_HOURS` | `24` | the tracked-box refresh cadence the manifest proposes; a whole number from 1 to 168, else the default |
| `CEX_IDS_PER_QUERY` | `100` | box ids per refresh query |
| `CEX_TIMEOUT_MS` | `6000` | one outbound Algolia call; keep it under the app's `ADAPTER_TIMEOUT_MS` (8000) |

A category name must be a verbatim facet string: a plausible guess matches
nothing, silently, and reads exactly like a category the shop emptied.
Changing an index points a source at another country's catalogue, which the
app cannot detect. All three shops are always declared; the app's
enabled-markets setting decides which are swept.

## Evidence

- `fixtures/country-categories-2026-09-03.md`: one facet query per index
  (`prod_cex_uk` 996,907 records and 300 categories, `prod_cex_es` 392,975 and
  273, `prod_cex_ie` 316,935 and 280), with the retro category name and record
  count per country. The compiled lists in `src/config.ts` are copied from it:
  the UK has two GameCube categories ("GameCube Games" and "GameCube
  Rarities", 183 boxes), Ireland says "Software" where the UK says "Games" for
  several consoles, Spain says "Juegos", and Spain and Ireland have no Virtual
  Boy, Neo Geo Pocket Color or Atari Lynx category.
- `fixtures/absent-vs-zero-price-fields-2026-09-09.md`: raw fetches of two
  boxes CeX does not buy, on both the Algolia and the detail channel. Both
  send `cashPriceCalculated: 0` and `exchangePriceCalculated: 0` with the key
  present, and both carry an explicit flag (`boxBuyAllowed` on Algolia,
  `cannotBuy` on the detail endpoint) that is the field to trust; the
  `webBuyAllowed` family disagrees with itself.
- `fixtures/algolia-query-snes.json`: one real Algolia answer for a SNES
  query, the input to the row fixture the app tests against.

## Getting the Algolia key

Goal: the two values `CEX_ALGOLIA_APP_ID` and `CEX_ALGOLIA_API_KEY` need.
This plugin ships without them. They belong to CeX, whose website sends them
to every visitor's browser so the page can search the catalogue; reading them
off the site and using them from a program of your own is your decision. CeX
publishes no API for this; keep the plugin's pace slow and use it for
yourself.

1. Open `https://uk.webuy.com` in a browser and search for anything.
2. In the browser's network inspector, find a request to
   `search.webuy.io/1/indexes/*/queries`.
3. Copy the values of `x-algolia-application-id` and `x-algolia-api-key` from
   its query string or headers, and put them in the plugin's env file as
   `CEX_ALGOLIA_APP_ID` and `CEX_ALGOLIA_API_KEY`.
4. Recreate the container. To check, `GET /health` answers
   `configured: true`, and the app's Settings screen lets the shops be
   enabled.

CeX rotates the pair occasionally. When the sweep starts logging 403s from
Algolia, repeat these steps; until then the app keeps serving the last synced
prices.

## How to build and run it

Goal: have the plugin answering on the app's compose network and approved in
the app.

Prerequisites: Docker with the compose plugin, this repository checked out,
and a RetroWatchdog deployment to attach it to.

1. From this repository's root, run
   `docker build -t retrowatchdog-cex-plugin:latest .`. To use another tag,
   set `CEX_PLUGIN_IMAGE` in the app's `.env` to it.
2. Put the Algolia pair in `.env.cex` beside the app's `.env` (see "Getting
   the Algolia key").
3. From the app's directory, run
   `docker compose --profile cex up -d cex-plugin`.
4. Run `docker compose logs cex-plugin`. The last line reads
   `cex-plugin serving cex, cex_es, cex_ie on port 8000 (protocol 3)`.
5. In the app, open Settings → Plugins. The CeX row is offered pending on
   first boot from `CEX_PLUGIN_URL`; press "Check now" and it reports a reply.
   Approve its roles, then switch its markets on in Settings → Markets.
6. Check: after the next sweep (Monday 03:00 by default) a CeX title appears in
   search with its prices, and the row in Settings → Plugins shows no error.

The build context is this repository and the package depends on nothing
outside it. The process runs as an unprivileged user and publishes no host
port.

## How to change a category list, an index, the Algolia key or the cadence

Goal: run the plugin with a setting other than its default.

Prerequisites: the plugin built and running as above.

1. Set the variable in `.env.cex` beside the app's `.env`, starting from
   `.env.example` if the file does not exist yet; every variable is listed
   under Configuration. A category name must be a verbatim facet string from
   `fixtures/country-categories-2026-09-03.md`.
2. Recreate the container: `docker compose --profile cex up -d cex-plugin`.
3. In Settings → Plugins, press "Check now" on the CeX row. A changed
   `CEX_SYNC_CRON` or `CEX_TRACKED_REFRESH_HOURS` shows as a changed manifest;
   approve it again, because the app schedules from the approved one.
4. Check: `docker compose logs cex-plugin` shows the boot line, the row shows
   no error, and after the next sweep a title from the new category appears
   in search. A category that matches nothing reads exactly like a category
   the shop emptied, so compare the string with the fixture before blaming
   the shop.

## How to run the tests

Goal: run this package's suite and type check.

Prerequisites: Node and pnpm, and `pnpm install` run in this repository.

1. Run `pnpm test`.
2. Run `pnpm typecheck`.
3. Check: vitest reports every file passed and `tsc` prints nothing.

Every test is offline, with an injected query function:

- `test/rows.test.ts`: the hit-to-row mapping, including the `boxBuyAllowed`
  gate, the rounding, the null and negative guards and the per-page dedupe.
- `test/units.test.ts`: the cursor walk against a scripted Algolia: the split,
  the order, the shortfall note, `complete`, and the rejection of a foreign
  cursor.
- `test/categories.test.ts`: every compiled category against a
  hand-transcribed copy of the facet fixture.
- `test/server.test.ts`: the five routes over a real loopback socket.

To run the process without Docker, `pnpm dev` starts `tsx watch` on port
8000. It reads the variables above from the environment; copy `.env.example`
to `.env` and export its values first.

## How to regenerate the fixtures

Goal: keep `manifest.fixture.json` equal to what the code produces after a
change to `src/manifest.ts`, `src/config.ts` or `src/rows.ts`, and record
the change in the app.

The app keeps a recorded copy of this plugin's manifest and of the rows it
builds from `fixtures/algolia-query-snes.json`, as
`apps/api/src/adapters/sidecar/fixtures/cex-manifest.json` and
`apps/api/src/adapters/sidecar/fixtures/cex-plugin-rows-2026-09-17.json` in
the `retrowatchdog` repository; its
`apps/api/test/adapters/sidecar/cexPluginContract.test.ts` runs
`validateManifest` over the first and the app's row parser over the second.
A change to the manifest or to the row mapping must be recorded there.

Prerequisites: the test prerequisites above.

1. Write a script inside this repository. A relative ESM import resolves
   against the file's own location, never the shell's working directory, and
   not at all inside a `tsx -e` string. The script prints
   `manifestPayload(loadSettings({}), scheduleFrom({}))` to
   `manifest.fixture.json`, and `rowsFrom(hits, "GBP")` over the hits of
   `fixtures/algolia-query-snes.json` to a rows file.
2. Run it with `npx tsx <script>` from this repository's root, then delete
   it.
3. Copy the two outputs into the app repository under the file names above.
4. Check: `pnpm test` here and the app's `cexPluginContract` test both pass.

## How to bump a dependency

Goal: move `undici`, `typescript` or `@types/node` to a new version.

1. Change the version in `package.json` and in both `RUN npm install --no-save`
   lines of the Dockerfile. The Dockerfile's exact versions are what the image
   builds and runs with; `package.json`'s ranges and `pnpm-lock.yaml` serve
   the local `pnpm install`, and nothing but this step keeps the two aligned.
2. Run `pnpm install`, then the tests above.
3. Rebuild and run as above, and check the boot line in the log.

`undici` is the one runtime dependency: its `fetch` is the one `MockAgent`
can intercept, so the tests exercise every path without reaching CeX.

## Legal

[LEGAL.md](LEGAL.md): the source's terms as last read, what they mean for
whoever runs this plugin, no warranty, not financial advice, no affiliation.
The names of the shops and marketplaces are their owners' trademarks, used
only to say where a price came from.

## License

Free software under the [GNU Affero General Public License v3.0](LICENSE),
and only that. Contributions are accepted under the terms in
[CONTRIBUTING.md](CONTRIBUTING.md).
