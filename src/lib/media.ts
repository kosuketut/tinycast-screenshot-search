import { LocalStorage } from "@raycast/api";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { type Dirent, existsSync as fileExists, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const execFileAsync = promisify(execFile) as (
  file: string,
  args: string[],
  options?: {
    encoding?: BufferEncoding;
    timeout?: number;
    maxBuffer?: number;
  },
) => Promise<{ stdout: string; stderr: string }>;

const CUSTOM_SCOPES_KEY = "custom-search-scopes";
const PINNED_ITEMS_KEY = "pinned-items-v1";
const IMAGE_EXTENSIONS = new Set([
  ".avif",
  ".bmp",
  ".gif",
  ".heic",
  ".heif",
  ".jpeg",
  ".jpg",
  ".png",
  ".tif",
  ".tiff",
  ".webp",
]);
const VIDEO_EXTENSIONS = new Set([".m4v", ".mov", ".mp4", ".webm"]);
const MEDIA_EXTENSIONS = [...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS];
// ponytail: bounded fallback walk; indexed macOS scopes avoid this ceiling.
const MAX_SCAN_DEPTH = 8;
const MAX_SCAN_ENTRIES_PER_SCOPE = 10_000;
const SPOTLIGHT_MEDIA_QUERY = `(${MEDIA_EXTENSIONS.map(
  (extension) => `kMDItemFSName == "*${extension}"cd`,
).join(" || ")})`;
const SPOTLIGHT_SCAN_TIMEOUT = 10_000;
// A folder is listed by one find, and Spotlight's paths by one stat per
// batch. Tinycast answers each fs call over a synchronous bridge, so statting
// 3,000 screenshots one at a time took half a second there.
// Birth time, modified time, size, path. Nanoseconds, so the milliseconds
// come out exactly as fs.stat gives them and the OCR index still matches.
const STAT_FORMAT = "%.9FB\t%.9Fm\t%z\t%N";
const STAT_BATCH_SIZE = 500;
const FIND_MEDIA_NAMES = MEDIA_EXTENSIONS.flatMap((extension, index) => [
  ...(index > 0 ? ["-o"] : []),
  "-iname",
  `*${extension}`,
]);

export type ScreenshotPreferences = ExtensionPreferences;

export type MediaItem = {
  id: string;
  path: string;
  name: string;
  kind: "image" | "video";
  capturedAt: number;
  modifiedAt: number;
  size: number;
  /** Recognized text, top to bottom. */
  lines?: string[];
};

export async function loadMediaItems(
  preferences: ScreenshotPreferences,
): Promise<MediaItem[]> {
  const scopes = await getSearchScopes(preferences);
  const items: MediaItem[] = [];
  const seen = new Set<string>();

  const includeAllMedia = Boolean(preferences.includeAllMedia);
  await Promise.all(
    scopes.map(async (scope) => {
      // Capture folders are already narrow; walking them avoids a slow Spotlight query.
      // Desktop is small in the common case and also benefits from the direct walk.
      if (
        looksLikeCaptureFolder(scope) ||
        path.basename(scope).toLocaleLowerCase() === "desktop"
      ) {
        await walkDirectory(scope, includeAllMedia, items, seen);
        return;
      }

      const indexed = await scanIndexedDirectory(
        scope,
        includeAllMedia,
        items,
        seen,
      );
      if (!indexed) await walkDirectory(scope, includeAllMedia, items, seen);
    }),
  );

  return items.sort(
    (a, b) => b.capturedAt - a.capturedAt || a.name.localeCompare(b.name),
  );
}

export async function getSearchScopes(
  preferences: ScreenshotPreferences,
): Promise<string[]> {
  const configured = parseScopeFolders(preferences.scopeFolders);
  const custom = await readCustomScopes();
  const candidates = [
    systemScreenshotFolder(),
    cleanShotFolder(),
    path.join(os.homedir(), "Desktop"),
    ...configured,
    ...custom,
  ];
  const scopes: string[] = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    if (!candidate) continue;
    const absolute = path.resolve(expandHome(candidate));
    let resolved = absolute;
    try {
      resolved = await fs.realpath(absolute);
    } catch {
      // Keep the absolute path for folders that are temporarily offline.
    }
    if (seen.has(resolved)) continue;
    seen.add(resolved);

    try {
      if ((await fs.stat(resolved)).isDirectory()) scopes.push(resolved);
    } catch {
      // A watched folder can be offline or deleted; ignore it until it returns.
    }
  }

  return scopes;
}

export async function addCustomScope(folder: string): Promise<void> {
  const scopes = await readCustomScopes();
  const resolved = path.resolve(expandHome(folder));
  if (!scopes.includes(resolved)) {
    await LocalStorage.setItem(
      CUSTOM_SCOPES_KEY,
      JSON.stringify([...scopes, resolved]),
    );
  }
}

export async function readPinnedPaths(): Promise<Set<string>> {
  try {
    const value = await LocalStorage.getItem<string>(PINNED_ITEMS_KEY);
    if (!value) return new Set();
    const parsed = JSON.parse(value);
    return new Set(
      Array.isArray(parsed)
        ? parsed.filter((item): item is string => typeof item === "string")
        : [],
    );
  } catch {
    return new Set();
  }
}

export async function writePinnedPaths(paths: Set<string>): Promise<void> {
  await LocalStorage.setItem(PINNED_ITEMS_KEY, JSON.stringify([...paths]));
}

export async function chooseFolder(): Promise<string | undefined> {
  if (process.platform !== "darwin") return undefined;

  try {
    const { stdout } = await execFileAsync(
      "/usr/bin/osascript",
      [
        "-e",
        'POSIX path of (choose folder with prompt "Add a screenshot search scope")',
      ],
      { encoding: "utf8", timeout: 60_000 },
    );
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

export async function readImageDataUrl(
  filePath: string,
): Promise<string | undefined> {
  const mimeType = imageMimeType(filePath);
  if (!mimeType) return undefined;

  try {
    const data = await fs.readFile(filePath);
    return `data:${mimeType};base64,${data.toString("base64")}`;
  } catch {
    return undefined;
  }
}

export function formatMediaDate(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(timestamp);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 0; value >= 1024 && index < units.length - 1; index += 1) {
    value /= 1024;
    unit = units[index + 1];
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${unit}`;
}

type ScanBudget = { remainingEntries: number };

async function scanIndexedDirectory(
  directory: string,
  includeAllMedia: boolean,
  items: MediaItem[],
  seen: Set<string>,
): Promise<boolean> {
  if (process.platform !== "darwin") return false;

  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      "/usr/bin/mdfind",
      ["-onlyin", directory, SPOTLIGHT_MEDIA_QUERY],
      {
        encoding: "utf8",
        timeout: SPOTLIGHT_SCAN_TIMEOUT,
        maxBuffer: 16 * 1024 * 1024,
      },
    ));
  } catch {
    return false;
  }

  const paths = stdout
    .split(/\r?\n/)
    .map((filePath) => filePath.trim())
    .filter(Boolean);
  if (paths.length === 0) return false;

  const wanted = paths.filter((filePath) =>
    isWanted(filePath, directory, includeAllMedia),
  );
  for (let start = 0; start < wanted.length; start += STAT_BATCH_SIZE) {
    const listing = await runListing("/usr/bin/stat", [
      "-f",
      STAT_FORMAT,
      "--",
      ...wanted.slice(start, start + STAT_BATCH_SIZE),
    ]);
    if (listing) addStatLines(listing, directory, includeAllMedia, items, seen);
  }
  return true;
}

async function walkDirectory(
  directory: string,
  includeAllMedia: boolean,
  items: MediaItem[],
  seen: Set<string>,
): Promise<void> {
  if (await findMedia(directory, includeAllMedia, items, seen)) return;
  await scanDirectory(directory, includeAllMedia, items, seen, false, 0, {
    remainingEntries: MAX_SCAN_ENTRIES_PER_SCOPE,
  });
}

/**
 * Walks `directory` the way `scanDirectory` does, skipping hidden entries and
 * stopping at the same depth, but in one find. Natively that walks 80,000
 * entries in about a third of a second, so it needs no entry budget.
 */
async function findMedia(
  directory: string,
  includeAllMedia: boolean,
  items: MediaItem[],
  seen: Set<string>,
): Promise<boolean> {
  if (process.platform !== "darwin") return false;

  const listing = await runListing("/usr/bin/find", [
    directory,
    "-mindepth",
    "1",
    "-maxdepth",
    String(MAX_SCAN_DEPTH + 1),
    "-name",
    ".*",
    "-prune",
    "-o",
    "-type",
    "f",
    "(",
    ...FIND_MEDIA_NAMES,
    ")",
    "-exec",
    "/usr/bin/stat",
    "-f",
    STAT_FORMAT,
    "{}",
    "+",
  ]);
  if (listing === undefined) return false;
  addStatLines(listing, directory, includeAllMedia, items, seen);
  return true;
}

/**
 * What a listing printed, including what it printed before a timeout or an
 * unreadable subfolder made it fail. Undefined when it printed nothing and
 * failed, so the caller can fall back to walking the folder itself.
 */
async function runListing(
  file: string,
  args: string[],
): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(file, args, {
      encoding: "utf8",
      timeout: SPOTLIGHT_SCAN_TIMEOUT,
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const stdout = (error as { stdout?: string }).stdout;
    return stdout || undefined;
  }
}

/** Adds the media files in `stat -f STAT_FORMAT` output. */
function addStatLines(
  listing: string,
  scope: string,
  includeAllMedia: boolean,
  items: MediaItem[],
  seen: Set<string>,
): void {
  for (const line of listing.split("\n")) {
    // A line break in a file name splits its line; neither half parses.
    const [birth, modified, size, ...rest] = line.split("\t");
    const filePath = rest.join("\t");
    const kind = mediaKind(filePath);
    if (!kind || !isWanted(filePath, scope, includeAllMedia)) continue;

    const modifiedAt = statMilliseconds(modified);
    const bytes = Number(size);
    if (!Number.isFinite(modifiedAt) || !Number.isFinite(bytes)) continue;
    const resolved = path.resolve(filePath);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    items.push({
      id: resolved,
      path: resolved,
      name: path.basename(resolved),
      kind,
      capturedAt: statMilliseconds(birth) || modifiedAt,
      modifiedAt,
      size: bytes,
    });
  }
}

/** `1760000060.123456789` as fs.stat's `mtimeMs` would give it. */
function statMilliseconds(value: string | undefined): number {
  const [seconds, nanoseconds = "0"] = (value ?? "").split(".");
  return Number(seconds) * 1e3 + Number(nanoseconds.padEnd(9, "0")) / 1e6;
}

function mediaKind(filePath: string): MediaItem["kind"] | undefined {
  const extension = path.extname(filePath).toLocaleLowerCase();
  return IMAGE_EXTENSIONS.has(extension)
    ? "image"
    : VIDEO_EXTENSIONS.has(extension)
      ? "video"
      : undefined;
}

function isWanted(
  filePath: string,
  scope: string,
  includeAllMedia: boolean,
): boolean {
  return (
    includeAllMedia ||
    looksLikeCapture(path.basename(filePath)) ||
    isCapturePath(filePath, scope)
  );
}

async function scanDirectory(
  directory: string,
  includeAllMedia: boolean,
  items: MediaItem[],
  seen: Set<string>,
  captureScope: boolean,
  depth: number,
  budget: ScanBudget,
): Promise<void> {
  if (depth > MAX_SCAN_DEPTH || budget.remainingEntries <= 0) return;
  const isCaptureScope = captureScope || looksLikeCaptureFolder(directory);
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }

  entries.sort(compareScanEntries);
  await Promise.all(
    entries.map(async (entry) => {
      if (entry.name.startsWith(".")) return;
      if (budget.remainingEntries-- <= 0) return;
      const filePath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        await scanDirectory(
          filePath,
          includeAllMedia,
          items,
          seen,
          isCaptureScope,
          depth + 1,
          budget,
        );
        return;
      }
      if (!entry.isFile()) return;

      await addMediaItem(
        filePath,
        includeAllMedia,
        isCaptureScope,
        items,
        seen,
      );
    }),
  );
}

async function addMediaItem(
  filePath: string,
  includeAllMedia: boolean,
  captureScope: boolean,
  items: MediaItem[],
  seen: Set<string>,
): Promise<void> {
  const name = path.basename(filePath);
  const kind = mediaKind(filePath);
  if (!kind || (!includeAllMedia && !captureScope && !looksLikeCapture(name)))
    return;

  const resolved = path.resolve(filePath);
  if (seen.has(resolved)) return;

  try {
    const stats = await fs.stat(resolved);
    if (!stats.isFile()) return;
    seen.add(resolved);
    items.push({
      id: resolved,
      path: resolved,
      name,
      kind,
      capturedAt: stats.birthtimeMs || stats.mtimeMs,
      modifiedAt: stats.mtimeMs,
      size: stats.size,
    });
  } catch {
    // Files can disappear while a screenshot folder is being scanned.
  }
}

function compareScanEntries(a: Dirent, b: Dirent): number {
  const priority = (entry: Dirent): number => {
    if (entry.isFile() && looksLikeCapture(entry.name)) return 0;
    if (entry.isDirectory() && looksLikeCaptureFolder(entry.name)) return 1;
    return entry.isFile() ? 2 : 3;
  };

  const difference = priority(a) - priority(b);
  if (difference !== 0) return difference;
  return priority(a) < 2
    ? b.name.localeCompare(a.name, undefined, { numeric: true })
    : a.name.localeCompare(b.name, undefined, { numeric: true });
}

function isCapturePath(filePath: string, scopeDirectory: string): boolean {
  const scope = path.resolve(scopeDirectory);
  let current = path.dirname(path.resolve(filePath));

  while (true) {
    if (looksLikeCaptureFolder(current)) return true;
    if (current === scope || !current.startsWith(`${scope}${path.sep}`))
      return false;
    current = path.dirname(current);
  }
}

function looksLikeCapture(fileName: string): boolean {
  const name = fileName.normalize("NFD").toLocaleLowerCase();
  return /screenshot|screen[ _-]?shot|screen[ _-]?record|screencapture|screen.?recording|スクリーンショット|bildschirmfoto|bildschirmaufnahme|capture d.?écran|enregistrement de l.?écran|captura de pantalla|schermata|截屏|截图/.test(
    name,
  );
}

function looksLikeCaptureFolder(folderPath: string): boolean {
  return /clean.?shot|screenshot|screen[ _-]?shot|screen[ _-]?record|screen_shot|captures?/i.test(
    path.basename(folderPath),
  );
}

function parseScopeFolders(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[\r\n,]+/)
    .map((folder) => folder.trim())
    .filter(Boolean);
}

function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value.replace(/^\$HOME(?=\/|$)/, os.homedir());
}

function systemScreenshotFolder(): string | undefined {
  const value = readDefault("com.apple.screencapture", "location");
  return value && !value.startsWith("Error") ? value : undefined;
}

function cleanShotFolder(): string | undefined {
  for (const key of [
    "saveFolder",
    "savePath",
    "folderPath",
    "destinationFolder",
  ]) {
    const value = readDefault("com.getcleanshot.app", key);
    if (value && !value.startsWith("Error")) return value;
  }

  const fallback = path.join(os.homedir(), "Pictures", "CleanShot");
  return fileExists(fallback) ? fallback : undefined;
}

function readDefault(domain: string, key: string): string | undefined {
  if (process.platform !== "darwin") return undefined;
  try {
    return execFileSync("/usr/bin/defaults", ["read", domain, key], {
      encoding: "utf8",
      timeout: 1_500,
    }).trim();
  } catch {
    return undefined;
  }
}

async function readCustomScopes(): Promise<string[]> {
  try {
    const value = await LocalStorage.getItem<string>(CUSTOM_SCOPES_KEY);
    if (!value) return [];
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function imageMimeType(filePath: string): string | undefined {
  switch (path.extname(filePath).toLocaleLowerCase()) {
    case ".avif":
      return "image/avif";
    case ".bmp":
      return "image/bmp";
    case ".gif":
      return "image/gif";
    case ".heic":
    case ".heif":
      return "image/heic";
    case ".jpeg":
    case ".jpg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".tif":
    case ".tiff":
      return "image/tiff";
    case ".webp":
      return "image/webp";
    default:
      return undefined;
  }
}
