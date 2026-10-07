// Ported from gyotaku (https://github.com/xevrion/gyotaku), crates/core/src/
// query.rs and the near-match search in index.rs. GPL-3.0-or-later.

/**
 * What the search bar holds: words to look for, and filters on where and when
 * a screenshot was taken. Modelled on gyotaku's query syntax.
 *
 * A filter is `key:value` with one of the keys below. Anything else with a
 * colon in it (`https://`, `12:30`, `error:`) is a word to search for, and so
 * are bare words like `today`.
 */
export type Filter =
  | { kind: "in"; value: string }
  | { kind: "name"; value: string }
  | { kind: "text"; value: string }
  | { kind: "since"; at: number }
  | { kind: "until"; at: number };

export type SearchQuery = {
  /** Each word has to appear in the file name or the recognized text. */
  terms: string[];
  filters: Filter[];
};

export type SearchableItem = {
  name: string;
  path: string;
  capturedAt: number;
  lines?: string[];
};

export type PreparedItem<T extends SearchableItem> = {
  item: T;
  name: string;
  lines: string[];
  all: string;
  /** `all` with OCR look-alikes folded together, for near matches. */
  folded: string;
};

export type SearchHit<T extends SearchableItem> = {
  item: T;
  /** Found only once OCR look-alikes (`0`/`o`, `rn`/`m`, …) were treated as one. */
  near: boolean;
  /** The first recognized line containing a search word, as it was read. */
  line?: string;
};

const FILTER_KEYS = new Set(["in", "name", "text", "date", "before", "after"]);
const DAY = 24 * 60 * 60 * 1000;
const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

export function parseSearchQuery(input: string, now = Date.now()): SearchQuery {
  const query: SearchQuery = { terms: [], filters: [] };

  for (const token of tokens(input)) {
    const colon = token.indexOf(":");
    const key = colon > 0 ? token.slice(0, colon).toLowerCase() : "";
    if (!FILTER_KEYS.has(key)) {
      query.terms.push(token);
      continue;
    }

    const value = unquote(token.slice(colon + 1)).trim();
    // Still being typed (`date:yes` on the way to `yesterday`). Searching for
    // it as text would empty the results for a moment on every keystroke.
    if (!value) continue;

    if (key === "in" || key === "name" || key === "text") {
      query.filters.push({ kind: key, value });
      continue;
    }

    const range = dateRange(value, now);
    if (!range) continue;
    if (key === "date") {
      query.filters.push({ kind: "since", at: range[0] });
      query.filters.push({ kind: "until", at: range[1] });
    } else if (key === "before") {
      query.filters.push({ kind: "until", at: range[0] });
    } else {
      query.filters.push({ kind: "since", at: range[0] });
    }
  }

  return query;
}

export function isEmptyQuery(query: SearchQuery): boolean {
  return query.terms.length === 0 && query.filters.length === 0;
}

type PreparedText = Omit<PreparedItem<SearchableItem>, "item">;

// Keyed by path. An entry is reused while the name and the recognized lines
// are the same arrays, so each index update only prepares what was just read.
const preparedCache = new Map<
  string,
  { name: string; lines?: string[]; text: PreparedText }
>();

/** Precompute the normalized text once per file, not per keystroke. */
export function prepareItems<T extends SearchableItem>(
  items: T[],
): PreparedItem<T>[] {
  return items.map((item) => {
    const cached = preparedCache.get(item.path);
    if (cached && cached.name === item.name && cached.lines === item.lines)
      return { ...cached.text, item };

    const name = normalize(item.name);
    const lines = (item.lines ?? []).map(normalize);
    const all = [name, ...lines].join("\n");
    const text = { name, lines, all, folded: fold(all) };
    preparedCache.set(item.path, { name: item.name, lines: item.lines, text });
    return { ...text, item };
  });
}

/**
 * Exact matches come first, newest first, followed by near matches: files
 * whose text only matches once OCR look-alikes are folded together.
 */
export function searchItems<T extends SearchableItem>(
  prepared: PreparedItem<T>[],
  query: SearchQuery,
): SearchHit<T>[] {
  const terms = query.terms.map(normalize).filter(Boolean);
  const candidates = prepared.filter((entry) =>
    passesFilters(entry, query.filters),
  );
  if (terms.length === 0)
    return candidates.map((entry) => ({ item: entry.item, near: false }));

  const exact: SearchHit<T>[] = [];
  const rest: PreparedItem<T>[] = [];
  for (const entry of candidates) {
    if (terms.every((term) => entry.all.includes(term))) {
      exact.push({
        item: entry.item,
        near: false,
        line: matchedLine(entry, (line) =>
          terms.some((term) => line.includes(term)),
        ),
      });
    } else {
      rest.push(entry);
    }
  }

  // A query with no word long enough to be misread has no near matches.
  if (terms.every((term) => swaps(term) === 0)) return exact;

  const folded = terms.map(fold);
  const near: SearchHit<T>[] = [];
  for (const entry of rest) {
    // The fold only narrows it down. Folded, "internally" holds "email"
    // (rn for m, l for i), so each candidate is checked against the text as
    // it was read for how many letters had to be taken for others.
    if (!folded.every((term) => entry.folded.includes(term))) continue;
    const chars = [...entry.all];
    if (!terms.every((term) => readsNear(chars, [...term], swaps(term))))
      continue;
    near.push({
      item: entry.item,
      near: true,
      line: matchedLine(entry, (line) =>
        terms.some((term) => readsNear([...line], [...term], swaps(term))),
      ),
    });
  }

  return [...exact, ...near];
}

function passesFilters<T extends SearchableItem>(
  entry: PreparedItem<T>,
  filters: Filter[],
): boolean {
  return filters.every((filter) => {
    switch (filter.kind) {
      case "name":
        return entry.name.includes(normalize(filter.value));
      case "text":
        return entry.lines.some((line) =>
          line.includes(normalize(filter.value)),
        );
      case "in":
        return inFolder(entry.item.path, filter.value);
      case "since":
        return entry.item.capturedAt >= filter.at;
      case "until":
        return entry.item.capturedAt < filter.at;
    }
  });
}

/** A folder on the way to the file whose name starts with `value`, ignoring case. */
function inFolder(filePath: string, value: string): boolean {
  const prefix = normalize(value);
  const folders = filePath.split("/").slice(0, -1);
  return folders.some((folder) => normalize(folder).startsWith(prefix));
}

function matchedLine<T extends SearchableItem>(
  entry: PreparedItem<T>,
  matches: (line: string) => boolean,
): string | undefined {
  const index = entry.lines.findIndex(matches);
  return index >= 0 ? entry.item.lines?.[index] : undefined;
}

/** Splits on whitespace, except inside a quoted filter value: `in:"my shots"`. */
function tokens(input: string): string[] {
  const result: string[] = [];
  let index = 0;
  while (index < input.length) {
    while (index < input.length && /\s/.test(input[index])) index += 1;
    if (index >= input.length) break;

    const start = index;
    while (index < input.length && !/\s/.test(input[index])) index += 1;
    const word = input.slice(start, index);
    const quote = word.indexOf(':"');
    if (quote >= 0 && !word.slice(quote + 2).includes('"')) {
      const close = input.indexOf('"', start + quote + 2);
      index = close < 0 ? input.length : close + 1;
    }
    result.push(input.slice(start, index));
  }
  return result;
}

function unquote(value: string): string {
  return value.replace(/^"/, "").replace(/"$/, "");
}

/** The stretch of time a date value covers, as `[from, to)` in milliseconds. */
export function dateRange(
  value: string,
  now = Date.now(),
): [number, number] | undefined {
  const text = value.trim().toLowerCase().replace(/\s+/g, " ");
  const today = startOfDay(now);
  const tomorrow = addDays(today, 1);

  switch (text) {
    case "today":
      return [today, tomorrow];
    case "yesterday":
      return [addDays(today, -1), today];
    // The last 7 and 30 days, today included.
    case "week":
      return [addDays(today, -6), tomorrow];
    case "month":
      return [addDays(today, -29), tomorrow];
  }

  const relative = text.match(
    /^(?:last|past|within) (\d+) (day|week|month|year)s?$/,
  );
  if (relative) {
    const amount = Number(relative[1]);
    const days = { day: 1, week: 7, month: 30, year: 365 }[
      relative[2] as "day" | "week" | "month" | "year"
    ];
    return [now - amount * days * DAY, now + 1];
  }

  const calendar = text.match(/^(this|last) (week|month|year)$/);
  if (calendar) {
    const start = new Date(today);
    const end = new Date(today);
    const last = calendar[1] === "last";
    if (calendar[2] === "week") {
      start.setDate(start.getDate() - ((start.getDay() || 7) - 1));
      if (last) start.setDate(start.getDate() - 7);
      end.setTime(start.getTime());
      end.setDate(end.getDate() + 7);
    } else if (calendar[2] === "month") {
      start.setDate(1);
      if (last) start.setMonth(start.getMonth() - 1);
      end.setTime(start.getTime());
      end.setMonth(end.getMonth() + 1);
    } else {
      start.setMonth(0, 1);
      if (last) start.setFullYear(start.getFullYear() - 1);
      end.setTime(start.getTime());
      end.setFullYear(end.getFullYear() + 1);
    }
    return [start.getTime(), end.getTime()];
  }

  // Three letters or more of a month's name: the most recent one, so in
  // October `aug` is this August and `nov` is last November.
  if (/^[a-z]{3,}$/.test(text)) {
    const month = MONTHS.findIndex((name) => name.startsWith(text));
    if (month < 0) return undefined;
    const current = new Date(now);
    const year =
      month <= current.getMonth()
        ? current.getFullYear()
        : current.getFullYear() - 1;
    return [localDate(year, month, 1), localDate(year, month + 1, 1)];
  }

  return isoRange(text);
}

/** `2026`, `2026-08` or `2026-08-01`. */
function isoRange(text: string): [number, number] | undefined {
  const match = text.match(/^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/);
  if (!match) return undefined;
  const year = Number(match[1]);
  if (!match[2]) return [localDate(year, 0, 1), localDate(year + 1, 0, 1)];

  const month = Number(match[2]) - 1;
  if (month < 0 || month > 11) return undefined;
  if (!match[3])
    return [localDate(year, month, 1), localDate(year, month + 1, 1)];

  const day = Number(match[3]);
  const start = new Date(localDate(year, month, day));
  if (start.getMonth() !== month || start.getDate() !== day) return undefined;
  return [start.getTime(), localDate(year, month, day + 1)];
}

function localDate(year: number, month: number, day: number): number {
  const date = new Date(0);
  date.setFullYear(year, month, day);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function startOfDay(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function addDays(timestamp: number, days: number): number {
  const date = new Date(timestamp);
  date.setDate(date.getDate() + days);
  return date.getTime();
}

/** Full-width and half-width forms, and case, all compare equal. */
export function normalize(text: string): string {
  return text.normalize("NFKC").toLowerCase();
}

// Letters OCR takes for one another. The first of each is what `fold`
// writes for all of them.
const TWINS = [
  ["o", "0"],
  ["l", "1", "i", "|"],
  ["s", "5", "$"],
  ["b", "8"],
];
// And the letters it reads as two, or two as one.
const PAIRS: [string, string][] = [
  ["m", "rn"],
  ["w", "vv"],
  ["d", "cl"],
];

function lookAlike(char: string): number {
  return TWINS.findIndex((group) => group.includes(char));
}

/**
 * Text the way OCR might have misread it, with every group of look-alikes
 * written the same way. Each character folds on its own, so the fold of a
 * word starts with the fold of each of its prefixes and search-as-you-type
 * keeps finding the file letter by letter. Spaces stay: folding them away
 * mostly found words that were apart all along ("in voice" for invoice).
 */
export function fold(text: string): string {
  let out = "";
  for (const char of text) {
    const group = lookAlike(char);
    if (group >= 0) {
      out += TWINS[group][0];
      continue;
    }
    const pair = PAIRS.find(([one]) => one === char);
    out += pair ? pair[1] : char;
  }
  return out;
}

/**
 * How many misread letters a word may have and still be a near match. None
 * under four letters, where one swap is a third of the word, one up to seven,
 * two from eight. Any more and ordinary words start matching each other.
 */
function swaps(term: string): number {
  const length = [...term].length;
  return length < 4 ? 0 : length < 8 ? 1 : 2;
}

/** Whether `term` appears in `text` with at most `budget` letters read as look-alikes. */
export function readsNear(
  text: string[],
  term: string[],
  budget: number,
): boolean {
  for (let start = 0; start < text.length; start += 1) {
    if (readsAs(text, start, term, 0, budget)) return true;
  }
  return false;
}

function readsAs(
  text: string[],
  at: number,
  term: string[],
  from: number,
  budget: number,
): boolean {
  if (from >= term.length) return true;
  if (at >= text.length) return false;
  const want = term[from];
  const got = text[at];
  if (got === want) return readsAs(text, at + 1, term, from + 1, budget);
  if (budget === 0) return false;

  const group = lookAlike(got);
  if (group >= 0 && group === lookAlike(want))
    return readsAs(text, at + 1, term, from + 1, budget - 1);

  return PAIRS.some(
    ([one, [first, second]]) =>
      (want === one &&
        got === first &&
        text[at + 1] === second &&
        readsAs(text, at + 2, term, from + 1, budget - 1)) ||
      (got === one &&
        want === first &&
        term[from + 1] === second &&
        readsAs(text, at + 1, term, from + 2, budget - 1)),
  );
}
