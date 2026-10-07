import {
  environment,
  getPreferenceValues,
  LaunchType,
  showHUD,
} from "@raycast/api";
import { loadMediaItems, readPinnedPaths } from "./lib/media";
import type { ScreenshotPreferences } from "./lib/media";
import {
  indexItems,
  pendingItems,
  readOcrIndex,
  staleRecords,
  saveOcrRecords,
} from "./lib/ocr";

// Each run reads for a bounded time; the next interval picks up the rest.
const RUN_BUDGET = 4 * 60 * 1000;

export default async function IndexScreenshots() {
  const preferences = getPreferenceValues<ScreenshotPreferences>();
  if (!preferences.textRecognition) return;

  const [items, pinned, index] = await Promise.all([
    loadMediaItems(preferences),
    readPinnedPaths(),
    readOcrIndex(),
  ]);
  const stale = staleRecords(index, preferences, pinned);
  await saveOcrRecords({}, stale);
  for (const filePath of stale) delete index[filePath];
  const pending = pendingItems(items, index, preferences, pinned);

  let done = 0;
  if (pending.length > 0)
    await indexItems(pending, index, {
      allowCloudFiles: preferences.allowCloudFiles,
      deadline: Date.now() + RUN_BUDGET,
      onProgress: (_, progress) => (done = progress.done),
    });

  if (environment.launchType === LaunchType.UserInitiated) {
    await showHUD(
      pending.length === 0
        ? "All screenshots are indexed"
        : done < pending.length
          ? `Read ${done} of ${pending.length} screenshots, the rest next run`
          : `Read text from ${done} screenshots`,
    );
  }
}
