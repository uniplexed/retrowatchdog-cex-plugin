# CeX country category facets — 2026-09-03

One Algolia query per index with `query: ""`, `hitsPerPage: 0`,
`facets: ["categoryFriendlyName"]`, `maxValuesPerFacet: 300`, through the
same public app id/key the UK sync uses, paced 10 s apart. These are LIVE
facet strings, not guesses — the category list a sync unit iterates must be
copied from here verbatim (a "reasonable guess" silently never matches).

| index | HTTP | records | distinct categories |
| --- | ---: | ---: | ---: |
| `prod_cex_uk` | 200 | 996,907 | 300 |
| `prod_cex_es` | 200 | 392,975 | 273 |
| `prod_cex_ie` | 200 | 316,935 | 280 |

## Retro game categories, per country, with record counts

The consoles RetroWatchdog tracks. "—" means the country has no category for
that console at all.

| console | UK | ES | IE |
| --- | --- | --- | --- |
| NES | NES Software (944) | NES Juegos (940) | NES Software (940) |
| SNES | Super NES Software (1694) | Super NES Juegos (1669) | Super NES Software (1674) |
| N64 | Nintendo 64 Software (966) | Nintendo 64 Juegos (938) | Nintendo 64 Software (932) |
| Game Boy | Game Boy Software (1603) | Game Boy Juegos (1598) | Game Boy Software (1598) |
| Game Boy Color | Game Boy Color Software (1538) | Game Boy Color Juegos (1524) | Game Boy Color Software (1524) |
| GBA | Gameboy Advance Software (495) | GBA Juegos (471) | Gameboy Advance Software (476) |
| GameCube | GameCube Games (438) + GameCube Rarities (183) | Gamecube Juegos (719) | GameCube Games (431) + GameCube Rarities (186) |
| Nintendo DS | Nintendo DS Games (1845) | DS Juegos (1825) | Nintendo DS Games (1902) |
| 3DS | 3DS Games (475) | 3DS Juegos (504) | 3DS Games (456) |
| Mega Drive | Mega Drive Software (1553) | Mega Drive Juegos (1541) | Mega Drive Software (1541) |
| Master System | Master System Software (1007) | Master System Juegos (968) | Master System Software (968) |
| Game Gear | Game Gear Games (712) | Game Gear Juegos (712) | Game Gear Software (712) |
| Saturn | Sega Saturn Games (721) | Sega Saturn Juegos (680) | Sega Saturn Software (680) |
| Dreamcast | Dreamcast Games (599) | Dreamcast Juegos (597) | Dreamcast Software (856) |
| PS1 | Playstation1 Games (1601) | PS1 Juegos (1587) | Playstation1 Software (1592) |
| PS2 | Playstation2 Games (2263) | Playstation2 Juegos (4228) | Playstation2 Games (2298) |
| Virtual Boy | Virtual Boy Software (132) | — | — |
| Neo Geo Pocket Color | Neo Geo Pocket Color Software (156) | — | — |
| Atari Lynx | Atari Lynx Software (288) | — | — |

## Detail hosts and storefronts (probed 2026-09-03, controller)

The category facets above say nothing about the per-country DETAIL channel, so
it was probed separately: one box id taken from each country's own index, then
that box requested on that country's detail host with that country's
storefront as origin/referer, and a HEAD on the storefront's product page.

| index | box | detail host | result | storefront |
| --- | --- | --- | --- | --- |
| `prod_cex_uk` | 045496420055 | `wss2.cex.uk.webuy.io` | 200 JSON — "Legend of Zelda: Breath of the Wild", sell 38 / cash 17 / exchange 24, in stock | `uk.webuy.com` 301 → `/product-detail/?id=…` |
| `prod_cex_es` | 045496420079 | `wss2.cex.es.webuy.io` | 200 JSON — same game, sell 50 / cash 22 / exchange 31, in stock | `es.webuy.com` 301 → `/product-detail/?id=…` |
| `prod_cex_ie` | 045496478728 | `wss2.cex.ie.webuy.io` | 200 JSON — "Legend of Zelda: Tears of the Kingdom", sell 52 / cash 26 / exchange 34, in stock | `ie.webuy.com` 301 → `/product-detail/?id=…` |

1. **All three detail hosts and storefronts are real**, and each answers for a
   box of its own catalog with the browser-like headers the adapter sends.
2. **The same game is priced differently per country** (38 GBP in the UK vs
   50 EUR in Spain for the same Switch Zelda), which is the whole point of
   treating a country as its own source rather than a label.
3. The product URL the adapter builds (`/product-detail?id=`) is answered with
   a 301 to the canonical `/product-detail/?id=` (note the slash). It resolves,
   so links work, but a future change could adopt the canonical form.

## What this establishes

1. **The naming suffix is per country, and it is not one rule.** ES appends
   "Juegos" to almost everything. IE is English but does NOT copy the UK
   names: Game Gear, Saturn, Dreamcast and PS1 are "Software" in IE where the
   UK says "Games", while GameCube/DS/3DS/PS2 are "Games" in both. Any
   mapping must come from this table, never from transforming the UK string.
2. **Spelling differs too**: ES writes "Gamecube" (lowercase c) and "GBA"
   where UK/IE write "GameCube" and "Gameboy Advance".
3. **The rare consoles exist only in the UK.** Virtual Boy, Neo Geo Pocket
   Color and Atari Lynx have no ES or IE category, so those countries'
   sync lists are shorter — not broken.
4. **GameCube has two categories in UK and IE** (Games + Rarities) but one in
   ES; the sync must take both where they exist.
5. ES's Playstation2 count (4228) is far above UK's (2263): the country
   catalogs are genuinely different inventories, not translations of one.

## Addendum 2026-10-18: PC

A live `categoryFriendlyName` facet query per index, filtered to PC names:
`prod_cex_uk` has "PC Games" (7784) and "PC CD-ROM" (2946), `prod_cex_es`
"PC Juegos" (8980), `prod_cex_ie` "PC Games" (7100). Hardware and accessory
categories ("PC Accessories", "Handheld Gaming PCs", …) are not swept.
