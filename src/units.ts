/**
 * One page of one category, and the cursor that remembers where the sweep is.
 *
 * Algolia returns at most 1,000 hits per query, so a big category is split
 * into half-open `sellPrice` ranges `[min, max)` (no gaps, no double counts).
 * The pending ranges live in the protocol `cursor` and each page makes EXACTLY
 * ONE Algolia call, so the app's limiter and breaker pace every call.
 */

import { categoryBody, type AlgoliaHit, type AlgoliaAnswer, type QueryFn } from "./algolia.js";
import { rowsFrom, type CatalogRow } from "./rows.js";

/** Verified: Algolia's hard retrieval cap for one query. */
const CEILING = 1000;
/** Below this a price range cannot be halved any further. */
const MIN_RANGE_WIDTH = 0.01;
/** An open top range has to be bounded before it can be split. */
const OPEN_TOP = 100_000;

/** A pending half-open `sellPrice` range, `null` meaning "no upper bound". */
type Range = [number, number | null];

interface Walk {
  /** ranges still to ask about, popped from the END (depth first, cheapest state) */
  ranges: Range[];
  /** hits known to be unreachable past the ceiling, carried across pages */
  shortfall: number;
}

/**
 * base64url of compact JSON, well under the protocol's 512-char bound. It
 * cannot repeat: every page pops a range or replaces it with two narrower ones.
 */
export function encodeCursor(walk: Walk): string {
  return Buffer.from(JSON.stringify(walk), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): Walk | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const { ranges, shortfall } = parsed as { ranges?: unknown; shortfall?: unknown };
    if (!Array.isArray(ranges) || typeof shortfall !== "number" || !Number.isFinite(shortfall)) {
      return null;
    }
    const checked: Range[] = [];
    for (const range of ranges) {
      if (!Array.isArray(range) || range.length !== 2) return null;
      const [min, max] = range as [unknown, unknown];
      if (typeof min !== "number" || !Number.isFinite(min) || min < 0) return null;
      if (max !== null && (typeof max !== "number" || !Number.isFinite(max) || max <= min)) {
        return null;
      }
      checked.push([min, max]);
    }
    if (checked.length === 0) return null;
    return { ranges: checked, shortfall };
  } catch {
    // 400, never a silent restart: a restarted partial sweep reported complete deletes rows
    return null;
  }
}

export interface UnitPage {
  rows: CatalogRow[];
  next: string | null;
  complete: boolean;
  notes?: string;
}

/**
 * `complete` is dangerous: the app DELETES every stored row of a complete unit
 * that the run did not write, so it is true only when the walk finished with
 * no shortfall. A page that only SPLIT a range answers zero rows.
 */
export async function fetchUnitPage(opts: {
  query: QueryFn;
  index: string;
  category: string;
  currency: string;
  cursor?: string;
}): Promise<UnitPage | "bad-cursor"> {
  const walk: Walk | null =
    opts.cursor === undefined ? { ranges: [[0, null]], shortfall: 0 } : decodeCursor(opts.cursor);
  if (walk === null) return "bad-cursor";

  const range = walk.ranges.pop();
  // cannot happen; asserted so a page never reports `complete` having asked nothing
  if (range === undefined) return "bad-cursor";
  const [min, max] = range;

  const answer: AlgoliaAnswer = await opts.query(
    opts.index,
    categoryBody(opts.category, CEILING, { min, max }),
  );

  if (answer.nbHits <= CEILING) return page(walk, answer.hits, opts.currency);

  const upper = max ?? OPEN_TOP;
  const mid = Math.round(((min + upper) / 2) * 100) / 100;
  if (upper - min < MIN_RANGE_WIDTH || mid <= min || mid >= upper) {
    // unsplittable (a thousand boxes at one price): keep these, report the rest as shortfall
    walk.shortfall += answer.nbHits - answer.hits.length;
    return page(walk, answer.hits, opts.currency);
  }
  // low half first (pushed last, popped first), so runs are deterministic
  walk.ranges.push([mid, max], [min, mid]);
  return page(walk, [], opts.currency);
}

function page(walk: Walk, hits: readonly AlgoliaHit[], currency: string): UnitPage {
  const done = walk.ranges.length === 0;
  const notes =
    walk.shortfall > 0
      ? `${walk.shortfall} hits unreachable past Algolia's ${CEILING}-hit retrieval ceiling`
      : undefined;
  return {
    rows: rowsFrom(hits, currency),
    next: done ? null : encodeCursor(walk),
    complete: done && walk.shortfall === 0,
    // Omitted, never null: the protocol checks presence, not truthiness.
    ...(notes === undefined ? {} : { notes }),
  };
}
