import { environment } from "@raycast/api";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { MediaItem } from "./media";
import { ensureHelper, run } from "./ocr";

/**
 * Small copies of the screenshots for the grid, by key. Tinycast draws a tile
 * from the whole file, and a page of 48 screenshots took seconds to fill in;
 * from 512-pixel copies it fills in at once.
 */
export type Thumbnails = Map<string, string>;

const THUMBNAIL_FOLDER = "thumbnails";
// Thumbnails of files since deleted or edited are cleared once this many
// more than the screenshots have piled up.
const PRUNE_SLACK = 100;

const keys = new Map<string, string>();

/**
 * Names the thumbnail of this version of the file. Kept once worked out: in
 * Tinycast each digest is a call across the bridge.
 */
export function thumbnailKey(item: MediaItem): string {
  const text = `${item.path}\n${Math.trunc(item.modifiedAt)}`;
  let key = keys.get(text);
  if (!key) {
    key = createHash("sha1").update(text).digest("hex");
    keys.set(text, key);
  }
  return key;
}

/** The thumbnails made so far, in one listing rather than a check per file. */
export async function readThumbnails(): Promise<Thumbnails> {
  const thumbnails: Thumbnails = new Map();
  try {
    for (const name of await fs.readdir(thumbnailFolder())) {
      const extension = path.extname(name);
      if (extension === ".jpg" || extension === ".png")
        thumbnails.set(
          path.basename(name, extension),
          path.join(thumbnailFolder(), name),
        );
    }
  } catch {
    // None made yet.
  }
  return thumbnails;
}

/**
 * Makes the thumbnails of `items` and returns the ones made. Cloud-only files
 * are skipped rather than downloaded, and keep their original in the grid.
 */
export async function makeThumbnails(items: MediaItem[]): Promise<Thumbnails> {
  const made: Thumbnails = new Map();
  const images = items.filter(
    (item) => item.kind === "image" && !item.path.includes("\n"),
  );
  if (images.length === 0) return made;
  const helper = await ensureHelper();
  if (!helper) return made;

  await fs.mkdir(thumbnailFolder(), { recursive: true });
  const stdout = await run(
    helper,
    [
      "--thumbnails",
      ...images.flatMap((item) => [
        item.path,
        path.join(thumbnailFolder(), thumbnailKey(item)),
      ]),
    ],
    images.length * 5_000,
  );
  for (const line of stdout.split("\n")) {
    try {
      const { thumbnail } = JSON.parse(line) as { thumbnail: string | null };
      if (thumbnail)
        made.set(
          path.basename(thumbnail, path.extname(thumbnail)),
          path.join(thumbnailFolder(), path.basename(thumbnail)),
        );
    } catch {
      // A partial line from a helper that timed out.
    }
  }
  return made;
}

/** Deletes the thumbnails of files that are gone or have changed. */
export async function pruneThumbnails(
  items: MediaItem[],
  thumbnails: Thumbnails,
): Promise<void> {
  if (thumbnails.size <= items.length + PRUNE_SLACK) return;
  const current = new Set(items.map(thumbnailKey));
  await Promise.all(
    [...thumbnails]
      .filter(([key]) => !current.has(key))
      .map(([, filePath]) => fs.rm(filePath, { force: true })),
  );
}

function thumbnailFolder(): string {
  return path.join(environment.supportPath, THUMBNAIL_FOLDER);
}
