import { environment, LocalStorage } from "@raycast/api";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { MediaItem, ScreenshotPreferences } from "./media";

const execFileAsync = promisify(execFile);

const INDEX_FILE = "ocr-index-v3.jsonl";
const LEGACY_INDEX_FILE = "ocr-index-v2.json";
const LEGACY_CACHE_KEY = "ocr-cache-v1";
const BATCH_SIZE = 6;
// One reader at a time: about 250 MB and one and a half cores at peak, which
// matters more than finishing the first full read a minute or two sooner.
const WORKERS = 1;
const SAVE_INTERVAL = 10_000;

// Vision reads small interface text and Japanese far better than the text
// Spotlight stores, which is empty for most screenshots. Compiled once into
// the support folder; `swift -e` would recompile on every file. With
// `--thumbnails` it makes the grid's thumbnails instead.
const HELPER_SOURCE = `
import Foundation
import ImageIO
import Vision

func emit(_ object: [String: Any]) {
  if let data = try? JSONSerialization.data(withJSONObject: object),
    let json = String(data: data, encoding: .utf8)
  {
    print(json)
    fflush(stdout)
  }
}

// A cloud placeholder (SF_DATALESS) would be downloaded by reading it.
// Checked here because Tinycast's fs.stat reports no block count.
func isCloudOnly(_ path: String) -> Bool {
  var info = stat()
  return stat(path, &info) == 0 && info.st_flags & 0x40000000 != 0
}

// Whether any pixel lets the background through, like the shadow around a
// window capture, which JPEG would turn black.
func hasTransparency(_ image: CGImage) -> Bool {
  if [.none, .noneSkipFirst, .noneSkipLast].contains(image.alphaInfo) { return false }
  let width = image.width
  let height = image.height
  var pixels = [UInt8](repeating: 0, count: width * height * 4)
  let drawn = pixels.withUnsafeMutableBytes { buffer -> Bool in
    guard
      let context = CGContext(
        data: buffer.baseAddress, width: width, height: height, bitsPerComponent: 8,
        bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
    else { return false }
    context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    return true
  }
  return !drawn || stride(from: 3, to: pixels.count, by: 4).contains { pixels[$0] < 255 }
}

// Pairs of screenshot and where its thumbnail goes, less the extension.
func writeThumbnails(_ pairs: [String]) {
  for index in stride(from: 0, to: pairs.count - 1, by: 2) {
    let path = pairs[index]
    var written: String?
    if !isCloudOnly(path) {
      autoreleasepool {
        let options: [CFString: Any] = [
          kCGImageSourceCreateThumbnailFromImageAlways: true,
          kCGImageSourceCreateThumbnailWithTransform: true,
          kCGImageSourceThumbnailMaxPixelSize: 512,
        ]
        guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
          let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
        else { return }
        let png = hasTransparency(image)
        let target = pairs[index + 1] + (png ? ".png" : ".jpg")
        // Written aside and moved in, so the grid never shows half a file.
        let temporary = target + ".tmp"
        guard
          let destination = CGImageDestinationCreateWithURL(
            URL(fileURLWithPath: temporary) as CFURL,
            (png ? "public.png" : "public.jpeg") as CFString, 1, nil)
        else { return }
        CGImageDestinationAddImage(
          destination, image,
          [kCGImageDestinationLossyCompressionQuality: 0.8] as CFDictionary)
        if CGImageDestinationFinalize(destination) && rename(temporary, target) == 0 {
          written = target
        }
      }
    }
    emit(["path": path, "thumbnail": written ?? NSNull()])
  }
}

var paths = Array(CommandLine.arguments.dropFirst())
if paths.first == "--thumbnails" {
  writeThumbnails(Array(paths.dropFirst()))
  exit(0)
}
let allowCloud = paths.first == "--allow-cloud"
if allowCloud { paths.removeFirst() }

for path in paths {
  var lines = [String]()
  var ok = false
  if !allowCloud && isCloudOnly(path) {
    emit(["path": path, "ok": false, "skipped": true, "lines": []])
    continue
  }
  autoreleasepool {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.recognitionLanguages = ["ja-JP", "en-US"]
    request.usesLanguageCorrection = true
    let handler = VNImageRequestHandler(url: URL(fileURLWithPath: path), options: [:])
    do {
      try handler.perform([request])
      ok = true
      // Top to bottom, then left to right, the way the screen reads.
      let observations = (request.results ?? []).sorted {
        abs($0.boundingBox.minY - $1.boundingBox.minY) > 0.01
          ? $0.boundingBox.minY > $1.boundingBox.minY
          : $0.boundingBox.minX < $1.boundingBox.minX
      }
      // Single characters are mostly icons read as letters.
      lines = observations.compactMap { $0.topCandidates(1).first?.string }
        .filter { $0.count > 1 }
    } catch {}
  }
  emit(["path": path, "ok": ok, "lines": lines])
}
`;

export type OcrRecord = {
  lines: string[];
  modifiedAt: number;
  indexedAt: number;
};

export type OcrIndex = Record<string, OcrRecord>;

export type IndexProgress = { done: number; total: number };

/**
 * The index is a log: one JSON line per record read, and one per record
 * removed, the last line for a path winning. Saving appends only what is new.
 * Rewriting the whole file on every save left hundreds of megabytes resident
 * in Tinycast, whose fs runs inside the launcher.
 */
export async function readOcrIndex(): Promise<OcrIndex> {
  let text: string;
  try {
    text = await fs.readFile(indexPath(), "utf8");
  } catch {
    return migrateLegacyIndex();
  }

  const index: OcrIndex = {};
  let lines = 0;
  for (const line of text.split("\n")) {
    if (!line) continue;
    lines += 1;
    try {
      const entry = JSON.parse(line) as LogEntry;
      if ("removed" in entry) delete index[entry.path];
      else
        index[entry.path] = {
          lines: entry.lines,
          modifiedAt: entry.modifiedAt,
          indexedAt: entry.indexedAt,
        };
    } catch {
      // A line cut short by a run that was stopped mid-write.
    }
  }

  // Superseded lines pile up as files change; drop them now and then.
  if (lines > Object.keys(index).length * 2 + 100) await compact(index);
  return index;
}

/** Appends records read and paths removed. Safe to call from both commands. */
export function saveOcrRecords(
  records: OcrIndex,
  removed: string[] = [],
): Promise<void> {
  const entries: LogEntry[] = [
    ...Object.entries(records).map(([filePath, record]) => ({
      path: filePath,
      ...record,
    })),
    ...removed.map((filePath) => ({ path: filePath, removed: true as const })),
  ];
  if (entries.length === 0) return writeChain;
  const write = writeChain.then(async () => {
    await fs.mkdir(environment.supportPath, { recursive: true });
    await fs.appendFile(indexPath(), toLog(entries));
  });
  writeChain = write.catch(() => undefined);
  return write;
}

type LogEntry =
  ({ path: string } & OcrRecord) | { path: string; removed: true };

let writeChain: Promise<void> = Promise.resolve();

function toLog(entries: LogEntry[]): string {
  return entries.map((entry) => `${JSON.stringify(entry)}\n`).join("");
}

async function compact(index: OcrIndex): Promise<void> {
  const temporary = `${indexPath()}.${Date.now()}.tmp`;
  await fs.writeFile(
    temporary,
    toLog(
      Object.entries(index).map(([filePath, record]) => ({
        path: filePath,
        ...record,
      })),
    ),
  );
  await fs.rename(temporary, indexPath());
}

/** Carries over the JSON index of the previous version, then removes it. */
async function migrateLegacyIndex(): Promise<OcrIndex> {
  // The v1 cache held Spotlight text, which is empty for most screenshots.
  await LocalStorage.removeItem(LEGACY_CACHE_KEY);
  const legacy = path.join(environment.supportPath, LEGACY_INDEX_FILE);
  try {
    const parsed = JSON.parse(await fs.readFile(legacy, "utf8")) as OcrIndex;
    await fs.mkdir(environment.supportPath, { recursive: true });
    await compact(parsed);
    await fs.rm(legacy, { force: true });
    return parsed;
  } catch {
    return {};
  }
}

export function applyOcrIndex(
  items: MediaItem[],
  index: OcrIndex,
): MediaItem[] {
  return items.map((item) => {
    const record = index[item.path];
    return record && record.modifiedAt === Math.trunc(item.modifiedAt)
      ? { ...item, lines: record.lines }
      : item;
  });
}

/** Records for files that are gone, or older than the storage duration allows. */
export function staleRecords(
  index: OcrIndex,
  preferences: ScreenshotPreferences,
  pinned: Set<string>,
  now = Date.now(),
): string[] {
  const retention = retentionMilliseconds(preferences.storageDuration);
  return Object.entries(index)
    .filter(
      ([filePath, record]) =>
        !existsSync(filePath) ||
        (retention !== undefined &&
          !pinned.has(filePath) &&
          record.modifiedAt < now - retention),
    )
    .map(([filePath]) => filePath);
}

/** Images still to be read, newest first, since recent ones are searched for most. */
export function pendingItems(
  items: MediaItem[],
  index: OcrIndex,
  preferences: ScreenshotPreferences,
  pinned: Set<string>,
  now = Date.now(),
): MediaItem[] {
  if (!preferences.textRecognition) return [];
  const retention = retentionMilliseconds(preferences.storageDuration);
  return items
    .filter(
      (item) =>
        item.kind === "image" &&
        !item.path.includes("\n") &&
        index[item.path]?.modifiedAt !== Math.trunc(item.modifiedAt) &&
        (retention === undefined ||
          pinned.has(item.path) ||
          item.capturedAt >= now - retention),
    )
    .sort((a, b) => b.capturedAt - a.capturedAt);
}

/**
 * Reads the text of `items` and saves it as it goes, so an interrupted run
 * keeps everything read so far. Returns the updated index.
 *
 * `onProgress` gets the working index, which keeps changing: copy it to keep
 * it. Copying here on every batch cost Tinycast hundreds of megabytes.
 */
export async function indexItems(
  items: MediaItem[],
  index: OcrIndex,
  options: {
    allowCloudFiles?: boolean;
    signal?: AbortSignal;
    deadline?: number;
    onProgress?: (index: OcrIndex, progress: IndexProgress) => void;
  } = {},
): Promise<OcrIndex> {
  const current: OcrIndex = { ...index };
  let unsaved: OcrIndex = {};
  let lastSave = Date.now();
  let done = 0;
  let cursor = 0;
  const batches: MediaItem[][] = [];
  for (let start = 0; start < items.length; start += BATCH_SIZE)
    batches.push(items.slice(start, start + BATCH_SIZE));

  const save = async () => {
    if (Object.keys(unsaved).length === 0) return;
    const pending = unsaved;
    unsaved = {};
    lastSave = Date.now();
    await saveOcrRecords(pending);
  };

  const helper = await ensureHelper();

  async function worker(): Promise<void> {
    while (cursor < batches.length) {
      if (options.signal?.aborted) return;
      if (options.deadline && Date.now() > options.deadline) return;
      const batch = batches[cursor++];
      const results = await recognize(
        batch,
        helper,
        Boolean(options.allowCloudFiles),
        options.signal,
      );
      if (options.signal?.aborted) return;

      const indexedAt = Date.now();
      for (const item of batch) {
        const lines = results.get(item.path.normalize("NFC"));
        if (!lines) continue;
        const record = {
          lines,
          modifiedAt: Math.trunc(item.modifiedAt),
          indexedAt,
        };
        unsaved[item.path] = record;
        current[item.path] = record;
      }
      done += batch.length;
      options.onProgress?.(current, { done, total: items.length });
      if (Date.now() - lastSave > SAVE_INTERVAL) await save();
    }
  }

  try {
    await Promise.all(
      Array.from({ length: Math.min(WORKERS, batches.length) }, () => worker()),
    );
  } finally {
    await save();
  }
  return current;
}

async function recognize(
  batch: MediaItem[],
  helper: string | undefined,
  allowCloudFiles: boolean,
  signal?: AbortSignal,
): Promise<Map<string, string[]>> {
  const results = new Map<string, string[]>();
  if (process.platform !== "darwin") return results;

  if (!helper) {
    // No Swift compiler: Spotlight's text is the best there is.
    for (const item of batch) {
      const text = await run(
        "/usr/bin/mdls",
        ["-raw", "-name", "kMDItemTextContent", item.path],
        4_000,
        signal,
      );
      const cleaned =
        !text || text === "(null)" ? "" : text.replace(/^\(|\)$/g, "");
      results.set(
        item.path.normalize("NFC"),
        cleaned.split(/\r?\n/).filter(Boolean),
      );
    }
    return results;
  }

  const stdout = await run(
    helper,
    [
      ...(allowCloudFiles ? ["--allow-cloud"] : []),
      ...batch.map((item) => item.path),
    ],
    batch.length * 20_000,
    signal,
  );
  for (const line of stdout.split("\n")) {
    try {
      const parsed = JSON.parse(line) as {
        path: string;
        ok: boolean;
        skipped?: boolean;
        lines: string[];
      };
      // Cloud placeholders are read once they are downloaded.
      if (parsed.skipped) continue;
      // An unreadable image is stored without text rather than retried on
      // every run; editing the file makes it read again.
      results.set(parsed.path.normalize("NFC"), parsed.ok ? parsed.lines : []);
    } catch {
      // A partial line from a helper that timed out.
    }
  }
  return results;
}

let helperPromise: Promise<string | undefined> | undefined;

export function ensureHelper(): Promise<string | undefined> {
  helperPromise ??= buildHelper();
  return helperPromise;
}

async function buildHelper(): Promise<string | undefined> {
  if (process.platform !== "darwin") return undefined;
  const hash = createHash("sha256")
    .update(HELPER_SOURCE)
    .digest("hex")
    .slice(0, 12);
  const binary = path.join(environment.supportPath, `vision-ocr-${hash}`);
  if (existsSync(binary)) return binary;

  try {
    await fs.mkdir(environment.supportPath, { recursive: true });
    const source = `${binary}.swift`;
    const temporary = `${binary}.${process.pid}.tmp`;
    await fs.writeFile(source, HELPER_SOURCE);
    await execFileAsync("/usr/bin/swiftc", ["-O", "-o", temporary, source], {
      timeout: 180_000,
    });
    await fs.rename(temporary, binary);
    return binary;
  } catch {
    return undefined;
  }
}

export async function run(
  command: string,
  args: string[],
  timeout: number,
  signal?: AbortSignal,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync(command, args, {
      encoding: "utf8",
      timeout,
      maxBuffer: 16 * 1024 * 1024,
      signal,
    });
    return stdout.trim();
  } catch (error) {
    // A timeout still leaves the lines printed before it.
    const stdout = (error as { stdout?: string }).stdout;
    return typeof stdout === "string" ? stdout.trim() : "";
  }
}

function indexPath(): string {
  return path.join(environment.supportPath, INDEX_FILE);
}

function retentionMilliseconds(value: string | undefined): number | undefined {
  const days: Record<string, number> = {
    "1d": 1,
    "1w": 7,
    "1m": 30,
    "3m": 90,
    "6m": 180,
    "1y": 365,
  };
  return value && days[value] ? days[value] * 24 * 60 * 60 * 1000 : undefined;
}
