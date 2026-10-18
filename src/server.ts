/**
 * The HTTP surface: `GET /health`, `GET /manifest` and the three catalog
 * endpoints of the protocol document (`docs/sidecar-protocol.md` in the
 * `retrowatchdog` repository) §4. No `GET /search`: a sync source's
 * game view is answered from the app's `catalog_items`. No pacing, retry,
 * cache or breaker here (see algolia.ts).
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { makeQuery, refreshBody, type QueryFn } from "./algolia.js";
import { loadSettings, shopById, type Settings } from "./config.js";
import { manifestPayload, scheduleFrom, PROTOCOL_VERSION, type Schedule } from "./manifest.js";
import { rowsFrom } from "./rows.js";
import { fetchUnitPage } from "./units.js";

export function healthPayload(settings: Settings): Record<string, unknown> {
  return {
    status: "ok",
    protocol: PROTOCOL_VERSION,
    // both halves of the Algolia pair, or the app must not enable the shops
    configured: Boolean(settings.appId && settings.apiKey),
    shops: settings.shops.map((shop) => shop.id),
  };
}

export function makeHandler(opts: {
  settings: Settings;
  schedule: Schedule;
  query: QueryFn;
}): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    route(req, res, opts).catch((error: unknown) => {
      // this process's bug: answer it rather than hang the socket, never as a 200
      send(res, 500, { error: describeError(error) });
    });
  };
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  opts: { settings: Settings; schedule: Schedule; query: QueryFn },
): Promise<void> {
  const { settings, schedule, query } = opts;
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const method = req.method ?? "GET";

  if (method === "POST" && url.pathname === "/catalog/refresh") {
    await handleRefresh(req, res, settings, query);
    return;
  }
  if (method !== "GET") {
    // always a JSON body: an empty one reads as a broken plugin
    send(res, 404, { error: `no such endpoint: ${method} ${url.pathname}` });
    return;
  }
  if (url.pathname === "/health") {
    send(res, 200, healthPayload(settings));
    return;
  }
  if (url.pathname === "/manifest") {
    send(res, 200, manifestPayload(settings, schedule));
    return;
  }
  if (url.pathname === "/catalog/units") {
    handleUnits(res, settings, url.searchParams);
    return;
  }
  if (url.pathname.startsWith("/catalog/units/")) {
    // the app percent-encodes the unit ("Game & Watch"); decode it back
    const unit = decodeURIComponent(url.pathname.slice("/catalog/units/".length));
    await handleUnitPage(res, settings, query, unit, url.searchParams);
    return;
  }
  send(res, 404, { error: `no such endpoint: ${url.pathname}` });
}

/** The `source` every catalog endpoint carries, resolved to a shop or an answer. */
function resolveShop(
  res: ServerResponse,
  settings: Settings,
  params: URLSearchParams,
): ReturnType<typeof shopById> {
  const source = params.get("source");
  if (!source) {
    send(res, 400, { error: "source is required" });
    return undefined;
  }
  const shop = shopById(settings, source);
  if (shop === undefined) {
    // 404: well formed, but this process does not serve that country
    send(res, 404, { error: `this plugin does not serve ${source}` });
    return undefined;
  }
  return shop;
}

function handleUnits(res: ServerResponse, settings: Settings, params: URLSearchParams): void {
  const shop = resolveShop(res, settings, params);
  if (shop === undefined) return;
  // the app requires 1..200 entries, no duplicates
  send(res, 200, [...shop.categories]);
}

async function handleUnitPage(
  res: ServerResponse,
  settings: Settings,
  query: QueryFn,
  unit: string,
  params: URLSearchParams,
): Promise<void> {
  const shop = resolveShop(res, settings, params);
  if (shop === undefined) return;
  if (!shop.categories.includes(unit)) {
    send(res, 404, { error: `${shop.id} does not sweep ${JSON.stringify(unit.slice(0, 128))}` });
    return;
  }
  const cursor = params.get("cursor");
  try {
    const page = await fetchUnitPage({
      query,
      index: shop.index,
      category: unit,
      currency: shop.currency,
      ...(cursor === null ? {} : { cursor }),
    });
    if (page === "bad-cursor") {
      // 400, never a restart: a partial sweep reported complete deletes rows app-side
      send(res, 400, { error: "cursor is not one this plugin issued" });
      return;
    }
    send(res, 200, page);
  } catch (error) {
    // 502 (a 429 included): the unit ends INCOMPLETE, so nothing is deleted
    send(res, 502, { error: describeError(error) });
  }
}

async function handleRefresh(
  req: IncomingMessage,
  res: ServerResponse,
  settings: Settings,
  query: QueryFn,
): Promise<void> {
  const body = await readJson(req);
  if (body === null) {
    send(res, 400, { error: "body must be a JSON object" });
    return;
  }
  const { source, ids } = body as { source?: unknown; ids?: unknown };
  if (typeof source !== "string" || source.length === 0) {
    send(res, 400, { error: "source is required" });
    return;
  }
  const shop = shopById(settings, source);
  if (shop === undefined) {
    send(res, 404, { error: `this plugin does not serve ${source}` });
    return;
  }
  // The ids were CeX's own objectIDs once, but they travel through the app's
  // database and back, and they are interpolated into Algolia's filter
  // syntax: only the characters an objectID can hold are accepted.
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(id))) {
    send(res, 400, { error: "ids must be an array of objectIDs: letters, digits, _ and -, 1 to 64 characters" });
    return;
  }
  // an id CeX does not answer is absent from `rows`: the app leaves that row alone
  try {
    const hits = [];
    // chunked to the measured filter length (Settings.idsPerQuery), one call at a time
    for (let at = 0; at < ids.length; at += settings.idsPerQuery) {
      const chunk = (ids as string[]).slice(at, at + settings.idsPerQuery);
      if (chunk.length === 0) continue;
      const answer = await query(shop.index, refreshBody(chunk));
      hits.push(...answer.hits);
    }
    send(res, 200, { rows: rowsFrom(hits, shop.currency) });
  } catch (error) {
    send(res, 502, { error: describeError(error) });
  }
}

/** At most 64 KiB of request body: the app sends at most 200 ids and a source id. */
const MAX_BODY_BYTES = 64 * 1024;

async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk as Buffer);
    bytes += buffer.length;
    // bounded, not trusted
    if (bytes > MAX_BODY_BYTES) return null;
    chunks.push(buffer);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.constructor.name}: ${error.message}`;
  return String(error);
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  res.writeHead(status, { "content-type": "application/json", "content-length": String(body.length) });
  res.end(body);
}

function main(): void {
  const settings = loadSettings();
  const schedule = scheduleFrom();
  const server = createServer(makeHandler({ settings, schedule, query: makeQuery(settings) }));
  // every interface inside the container; compose publishes no host port for it
  server.listen(settings.port, () => {
    // eslint-disable-next-line no-console -- this package has no logging dependency by design
    console.log(
      `cex-plugin serving ${settings.shops.map((shop) => shop.id).join(", ")} on port ${settings.port} (protocol ${PROTOCOL_VERSION})`,
    );
  });
}

// run only when executed directly, never when a test imports this file
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
