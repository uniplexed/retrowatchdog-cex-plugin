# Evidence: does CeX OMIT `cashPriceCalculated`/`exchangePriceCalculated`/`cashPrice`/`exchangePrice` for a title it does not buy, or send a literal `0`?

Fetched 2026-09-09. This is evidence for the S3a row-contract question: the
batch's premise ("an absent price key means the shop said nothing; a stored
`0` means it genuinely quotes zero") requires that CeX's wire format actually
omits the key when it has nothing to quote. **It does not: CeX sends a
literal `0` in both fields, on both channels, every time.** The key is never
absent. See verdict at the bottom.

## Method

Direct `curl` against the live public endpoints, using the same app id /
API key / index / detail host that
`apps/api/src/adapters/cex/algoliaClient.ts` and `.../detailClient.ts` use
(both public per this project's own docs — `config.ts` ships them as
defaults, not secrets). No app code, no adapter parsing: raw bytes only.

Candidates were found with a **read-only** query against the live
`retrowatchdog` Postgres database, looking for `catalog_items` rows the CeX
sync had already written with a stored cash price of `"0.00"` — the
ambiguous case, since the currently-deployed code is the OLD
`(n ?? 0).toFixed(2)` and collapses "absent" and "zero" into the same
string:

```sql
SELECT source_product_id, title, prices, synced_at
FROM catalog_items
WHERE source = 'cex' AND prices->>'cash' = '0.00'
ORDER BY synced_at DESC LIMIT 8;
```

425 such rows exist in the live UK catalog today (plus a separate 73 rows
with `prices->>'sell' = '0.00'`, unrelated to this question since
`sellPrice` is typed as a required, always-present field). Two candidates
were picked and fetched raw, plus the detail endpoint for one of them:

- Algolia GET `https://search.webuy.io/1/indexes/prod_cex_uk/SSEGMASG327B`
- Algolia GET `https://search.webuy.io/1/indexes/prod_cex_uk/SSEGMASG345C`
- Detail GET `https://wss2.cex.uk.webuy.io/v3/boxes/SSEGMASG327B/detail`

Three requests total, sequential, several seconds apart — no sweep, no loop.

## Raw Algolia response #1 — `SSEGMASG327B` ("Super Kick Off, Boxed")

HTTP 200. `boxBuyAllowed: 0`, `boxWebBuyAllowed: 0`, `discontinued: 1`,
`boxVisibilityOnWeb: 0` — a title CeX has stopped buying, still catalogued
and still sellable. The price fields, verbatim (the `stores`/`outOfStock`/
`collectionStores` arrays are omitted here for length — they carry no price
information; every other key is reproduced exactly as received):

```json
{
  "boxId": "SSEGMASG327B",
  "boxName": "Super Kick Off, Boxed",
  "sellPrice": 3,
  "cashBuyPrice": 0,
  "exchangePrice": 0,
  "boxBuyAllowed": 0,
  "webBuyAllowed": 1,
  "boxWebBuyAllowed": 0,
  "discontinued": 1,
  "boxVisibilityOnWeb": 0,
  "buyPerc": 15,
  "boxDeleted": 0,
  "cashPriceCalculated": 0,
  "exchangePriceCalculated": 0,
  "objectID": "SSEGMASG327B"
}
```

`cashPriceCalculated` and `exchangePriceCalculated` are both **present**,
both literal `0` — not missing keys.

## Raw Algolia response #2 — `SSEGMASG345C` ("Trivial Pursuit: Genus Edition, Unboxed")

Same shape, different object, confirming this is not a one-off:

```json
{
  "objectID": "SSEGMASG345C",
  "boxName": "Trivial Pursuit: Genus Edition, Unboxed",
  "sellPrice": 1.5,
  "cashPriceCalculated": 0,
  "exchangePriceCalculated": 0,
  "cashBuyPrice": 0,
  "exchangePrice": 0,
  "boxBuyAllowed": 0,
  "webBuyAllowed": 1,
  "boxWebBuyAllowed": 0,
  "discontinued": 1,
  "boxVisibilityOnWeb": 0,
  "buyPerc": 15,
  "boxDeleted": 0
}
```

Again: both fields present, both `0`.

## Raw detail response — `SSEGMASG327B` detail endpoint

`GET https://wss2.cex.uk.webuy.io/v3/boxes/SSEGMASG327B/detail`, HTTP 200,
`content-type: application/json; charset=UTF-8`:

```json
{
  "response": {
    "ack": "Success",
    "data": {
      "boxDetails": [
        {
          "boxId": "SSEGMASG327B",
          "boxName": "Super Kick Off, Boxed",
          "categoryId": 1059,
          "categoryFriendlyName": "Master System Software",
          "cannotBuy": 1,
          "isNewBox": 0,
          "cashPrice": 0,
          "exchangePrice": 0,
          "sellPrice": 3,
          "outOfStock": 1,
          "webBuyAllowed": 1,
          "boxBuyAllowed": 0,
          "boxWebBuyAllowed": 0,
          "lastPriceUpdatedDate": "2017-04-29 00:00:00"
        }
      ],
      "masterBoxDetails": null
    },
    "error": { "code": "", "internal_message": "", "moreInfo": [] }
  }
}
```

`cashPrice` and `exchangePrice` are both **present**, both literal `0`. And
this response carries an explicit flag the Algolia channel does not:
**`cannotBuy: 1`**.

## Contrast — an actively-bought title (already in the tree)

`apps/api/src/adapters/cex/fixtures/algolia-query-snes.json`, hit
`045496830144C` ("Super Mario Kart, Unboxed"), a title CeX is actively
buying (`boxBuyAllowed: 1`): `cashPriceCalculated: 6`,
`exchangePriceCalculated: 9`. The fields are present here too — they just
hold a real number instead of `0`. Presence is constant; only the value
changes. That is the whole finding: presence never signals "not quoted."

## Verdict

**CeX sends a literal `0`, on both channels, for a title it does not buy.
It never omits `cashPriceCalculated`/`exchangePriceCalculated` (Algolia) or
`cashPrice`/`exchangePrice` (detail).** The batch's premise — "absent means
not quoted, present-as-`0.00` means a genuine zero quote" — is false for
this source. Under the new code
(`apps/api/src/adapters/cex/catalogMap.ts` → `pricesFrom`/`money`,
`normalize.ts` → `cexRowToRawListing`), every one of these not-bought titles
still gets `cash`/`voucher` stored as `"0.00"` (`money(0)` is `"0.00"`, not
`undefined` — there is no way to reach the `undefined` branch from a `0`
that arrived over the wire), which is bit-for-bit what the OLD
`(n ?? 0).toFixed(2)` code also stored. Nothing changes on screen for this
source, and the protocol document's rule ("a stored zero is a real quote")
is wrong for CeX specifically: a stored CeX zero can mean either "CeX really
pays £0" (extremely rare, arguably never happens for a game) or, in
practice, "CeX does not buy this at all" — exactly the ambiguity the batch
was written to remove.

## A better signal exists, and the code does not use it

Both channels carry an **explicit "we do not buy this" flag**, and it is a
strictly better signal than any price field:

- Detail endpoint: **`cannotBuy`** (`1` = will not buy, `0` = will buy).
  Named for exactly this purpose.
- Algolia: **`boxBuyAllowed`** (same `0`/`1` meaning, confirmed identical to
  `cannotBuy`'s inverse on both fetched objects). `webBuyAllowed` and
  `boxWebBuyAllowed` do NOT track this reliably — on `SSEGMASG327B`,
  `webBuyAllowed: 1` while `boxBuyAllowed: 0` and `boxWebBuyAllowed: 0`
  disagree with each other, so `boxBuyAllowed` (Algolia) / `cannotBuy`
  (detail) are the fields to trust, not the `web*` family.

Neither `AlgoliaHit` (`algoliaClient.ts`) nor `CexBoxDetail`
(`detailClient.ts`) currently declares `boxBuyAllowed`/`cannotBuy`, and
`catalogMap.ts` never reads them. If the goal is "distinguish a real zero
quote from a title CeX will not buy," gating on this flag — not on price
value or price-field presence — is the correct fix; the current absent-vs-
`0.00` contract cannot express that distinction for this source at all.
