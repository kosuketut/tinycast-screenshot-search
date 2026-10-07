import {
  Action,
  ActionPanel,
  Clipboard,
  getPreferenceValues,
  Grid,
  Icon,
  Keyboard,
  LocalStorage,
  openExtensionPreferences,
  showToast,
  Toast,
  useNavigation,
} from "@raycast/api";
import { useEffect, useMemo, useState } from "react";
import {
  addCustomScope,
  chooseFolder,
  formatBytes,
  formatMediaDate,
  loadMediaItems,
  readImageDataUrl,
  readPinnedPaths,
  writePinnedPaths,
} from "./lib/media";
import type { MediaItem, ScreenshotPreferences } from "./lib/media";
import {
  applyOcrIndex,
  indexItems,
  pendingItems,
  readOcrIndex,
  staleRecords,
  saveOcrRecords,
} from "./lib/ocr";
import type { IndexProgress, OcrIndex } from "./lib/ocr";
import { parseSearchQuery, prepareItems, searchItems } from "./lib/query";

const COLUMN_KEY = "column-count";
const DEFAULT_COLUMNS = 4;
const MIN_COLUMNS = 3;
const MAX_COLUMNS = 6;
const PAGE_SIZE = 48;
// Each update re-renders the grid; in Tinycast that crosses the native bridge.
const PROGRESS_INTERVAL = 5_000;
// Opens and closes the preview. Space is left for typing
// multi-word searches.
const PREVIEW_SHORTCUT: Keyboard.Shortcut = { modifiers: ["ctrl"], key: "y" };
// Tinycast runs Raycast extensions but has no Grid pagination, so it gets a
// Show More tile instead. Drawing every screenshot at once cost about 90 MB.
const IS_TINYCAST = Boolean(
  (process.versions as Record<string, string | undefined>).tinycast,
);

type GridActionsProps = {
  columns: number;
  resetColumns: () => void;
  changeColumns: (delta: number) => void;
  addScope: () => Promise<void>;
};

export default function SearchScreenshots() {
  const preferences = useMemo(
    () => getPreferenceValues<ScreenshotPreferences>(),
    [],
  );
  const [scannedItems, setScannedItems] = useState<MediaItem[]>([]);
  const [ocrIndex, setOcrIndex] = useState<OcrIndex>({});
  const [progress, setProgress] = useState<IndexProgress>();
  const [pinned, setPinned] = useState<Set<string>>(new Set());
  const [columns, setColumns] = useState(
    clampColumns(Number(preferences.columnCount)),
  );
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [selectedItemId, setSelectedItemId] = useState<string>();
  const [searchText, setSearchText] = useState("");
  const { push } = useNavigation();
  const [isLoading, setIsLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);

  const items = useMemo(
    () => applyOcrIndex(scannedItems, ocrIndex),
    [scannedItems, ocrIndex],
  );
  const prepared = useMemo(() => prepareItems(items), [items]);
  const query = useMemo(() => parseSearchQuery(searchText), [searchText]);
  const hits = useMemo(() => searchItems(prepared, query), [prepared, query]);
  const visibleItems = useMemo(() => hits.map((hit) => hit.item), [hits]);
  const showMatchedLines = query.terms.length > 0;

  useEffect(() => {
    void LocalStorage.getItem<string>(COLUMN_KEY).then((value) => {
      if (value) setColumns(clampColumns(Number(value)));
    });
  }, []);

  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [refreshKey, searchText]);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    async function load() {
      setIsLoading(true);
      setProgress(undefined);
      const [nextItems, nextPinned, nextIndex] = await Promise.all([
        loadMediaItems(preferences),
        readPinnedPaths(),
        readOcrIndex(),
      ]);
      if (cancelled) return;

      setScannedItems(nextItems);
      setPinned(nextPinned);
      setOcrIndex(nextIndex);
      setIsLoading(false);

      const stale = staleRecords(nextIndex, preferences, nextPinned);
      await saveOcrRecords({}, stale);
      const index = { ...nextIndex };
      for (const filePath of stale) delete index[filePath];
      const pending = pendingItems(nextItems, index, preferences, nextPinned);
      if (cancelled || pending.length === 0) return;

      // Read in the background, newest first; search works on what is
      // already read and results fill in as more is.
      let lastUpdate = 0;
      setProgress({ done: 0, total: pending.length });
      const finalIndex = await indexItems(pending, index, {
        allowCloudFiles: preferences.allowCloudFiles,
        signal: controller.signal,
        onProgress: (updated, next) => {
          if (cancelled || Date.now() - lastUpdate < PROGRESS_INTERVAL) return;
          lastUpdate = Date.now();
          setOcrIndex({ ...updated });
          setProgress(next);
        },
      });
      if (cancelled) return;
      setOcrIndex(finalIndex);
      setProgress(undefined);
    }

    void load().catch(async (error) => {
      if (cancelled) return;
      setIsLoading(false);
      setProgress(undefined);
      await showToast({
        style: Toast.Style.Failure,
        title: "Could Not Read Screenshot Text",
        message: error instanceof Error ? error.message : undefined,
      });
    });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [preferences, refreshKey]);

  const changeColumns = (delta: number) => {
    setColumns((current) => {
      const next = clampColumns(current + delta);
      void LocalStorage.setItem(COLUMN_KEY, String(next));
      return next;
    });
  };

  const resetColumns = () => {
    const next = clampColumns(Number(preferences.columnCount));
    setColumns(next);
    void LocalStorage.setItem(COLUMN_KEY, String(next));
  };

  const addScope = async () => {
    const folder = await chooseFolder();
    if (!folder) return;
    await addCustomScope(folder);
    await showToast({
      style: Toast.Style.Success,
      title: "Search Scope Added",
      message: folder,
    });
    setRefreshKey((current) => current + 1);
  };

  // Pushed rather than swapped in, so going back keeps the grid as it was:
  // the same query, scroll position and selection (Tinycast has no
  // selectedItemId to restore it with).
  const openPreview = (item: MediaItem) => {
    setSelectedItemId(item.id);
    push(<PreviewView item={item} />);
  };

  const removeItem = (filePath: string) => {
    setScannedItems((current) =>
      current.filter((candidate) => candidate.path !== filePath),
    );
  };

  const gridActions = (
    <GridActions
      columns={columns}
      resetColumns={resetColumns}
      changeColumns={changeColumns}
      addScope={addScope}
    />
  );

  return (
    <Grid
      key="screenshots"
      columns={columns}
      inset={Grid.Inset.Medium}
      aspectRatio="4/3"
      fit={Grid.Fit.Fill}
      isLoading={isLoading || progress !== undefined}
      navigationTitle={
        progress ? `Reading Text ${progress.done}/${progress.total}` : undefined
      }
      selectedItemId={selectedItemId}
      onSelectionChange={(id) => setSelectedItemId(id ?? undefined)}
      searchText={searchText}
      onSearchTextChange={setSearchText}
      searchBarPlaceholder="Search text in screenshots…  in:  date:  before:  after:"
      actions={gridActions}
      filtering={false}
      pagination={
        IS_TINYCAST
          ? undefined
          : {
              pageSize: PAGE_SIZE,
              hasMore: visibleItems.length > visibleCount,
              onLoadMore: () =>
                setVisibleCount((current) => current + PAGE_SIZE),
            }
      }
    >
      {(["exact", "near"] as const).map((kind) => {
        const sectionHits = hits
          .slice(0, visibleCount)
          .filter((hit) => hit.near === (kind === "near"));
        if (sectionHits.length === 0) return null;
        return (
          <Grid.Section
            key={kind}
            title={
              kind === "near"
                ? "Near Matches"
                : hits.some((hit) => hit.near)
                  ? "Matches"
                  : undefined
            }
            subtitle={
              kind === "near"
                ? "Read with look-alike characters, such as 0 for O"
                : undefined
            }
          >
            {sectionHits.map(({ item, line }) => (
              <Grid.Item
                key={item.id}
                id={item.id}
                content={
                  item.kind === "image" ? { source: item.path } : Icon.Video
                }
                title={item.name}
                subtitle={
                  showMatchedLines && line
                    ? line
                    : `${formatMediaDate(item.capturedAt)} · ${formatBytes(item.size)}`
                }
                accessory={
                  pinned.has(item.path)
                    ? { icon: Icon.Pin, tooltip: "Pinned" }
                    : undefined
                }
                quickLook={{ path: item.path }}
                actions={
                  <ItemActions
                    item={item}
                    isPinned={pinned.has(item.path)}
                    onPreview={() => openPreview(item)}
                    onTogglePinned={async () => {
                      const next = new Set(pinned);
                      if (next.has(item.path)) next.delete(item.path);
                      else next.add(item.path);
                      setPinned(next);
                      await writePinnedPaths(next);
                    }}
                    onTrash={() => removeItem(item.path)}
                    columns={columns}
                    resetColumns={resetColumns}
                    changeColumns={changeColumns}
                    addScope={addScope}
                  />
                }
              />
            ))}
          </Grid.Section>
        );
      })}
      {IS_TINYCAST && hits.length > visibleCount ? (
        <Grid.Section key="more">
          <Grid.Item
            id="show-more"
            content={Icon.Plus}
            title={`Show ${Math.min(PAGE_SIZE, hits.length - visibleCount)} More`}
            subtitle={`${visibleCount} of ${hits.length} shown`}
            actions={
              <ActionPanel>
                <Action
                  title="Show More"
                  icon={Icon.Plus}
                  onAction={() =>
                    setVisibleCount((current) => current + PAGE_SIZE)
                  }
                />
              </ActionPanel>
            }
          />
        </Grid.Section>
      ) : null}
      {!isLoading && visibleItems.length === 0 ? (
        <Grid.EmptyView
          actions={gridActions}
          icon={Icon.MagnifyingGlass}
          title={
            items.length === 0
              ? "No screenshots found"
              : "No matching screenshots"
          }
          description={
            items.length === 0
              ? "Add a folder in Settings or use Add Search Scope from the Action Panel."
              : progress
                ? `Still reading text: ${progress.done} of ${progress.total} screenshots. Matches appear as they are read.`
                : "Every word must appear in the screenshot. Narrow with in:, date:, before:, or after:."
          }
        />
      ) : null}
    </Grid>
  );
}

function PreviewView({ item }: { item: MediaItem }) {
  const { pop } = useNavigation();
  const [source, setSource] = useState<string>();
  const [isLoading, setIsLoading] = useState(item.kind === "image");

  useEffect(() => {
    if (item.kind !== "image") return;
    let cancelled = false;
    void readImageDataUrl(item.path).then((dataUrl) => {
      if (cancelled) return;
      setSource(dataUrl);
      setIsLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [item]);

  return (
    <Grid
      columns={1}
      inset={Grid.Inset.Zero}
      aspectRatio={"21/10" as Grid.AspectRatio}
      fit={Grid.Fit.Contain}
      isLoading={isLoading}
      filtering={false}
      actions={
        <ActionPanel>
          <Action.CopyToClipboard
            title={item.kind === "image" ? "Copy Screenshot" : "Copy Recording"}
            icon={Icon.Clipboard}
            content={{ file: item.path }}
          />
          <Action
            title="Back to Screenshots"
            icon={Icon.ArrowLeft}
            shortcut={PREVIEW_SHORTCUT}
            onAction={pop}
          />
          {item.lines?.length ? (
            <Action.CopyToClipboard
              title="Copy Text"
              icon={Icon.Text}
              shortcut={Keyboard.Shortcut.Common.Copy}
              content={item.lines.join("\n")}
            />
          ) : null}
          <Action.Open title="Open" target={item.path} />
          <Action.ShowInFinder path={item.path} />
        </ActionPanel>
      }
    >
      <Grid.Item
        id={item.id}
        content={
          item.kind === "image" ? { source: source ?? item.path } : Icon.Video
        }
      />
    </Grid>
  );
}

function ItemActions({
  item,
  isPinned,
  onPreview,
  onTogglePinned,
  onTrash,
  columns,
  resetColumns,
  changeColumns,
  addScope,
}: GridActionsProps & {
  item: MediaItem;
  isPinned: boolean;
  onPreview: () => void;
  onTogglePinned: () => Promise<void>;
  onTrash: () => void;
}) {
  return (
    <ActionPanel>
      <Action.CopyToClipboard
        title={item.kind === "image" ? "Copy Screenshot" : "Copy Recording"}
        icon={Icon.Clipboard}
        content={{ file: item.path }}
      />
      <Action
        title={
          item.kind === "image" ? "Preview Screenshot" : "Preview Recording"
        }
        icon={Icon.Eye}
        shortcut={PREVIEW_SHORTCUT}
        onAction={onPreview}
      />
      <Action
        title={item.kind === "image" ? "Paste Screenshot" : "Paste Recording"}
        icon={Icon.Clipboard}
        onAction={() => pasteFile(item.path, item.name)}
      />
      {item.lines?.length ? (
        <Action.CopyToClipboard
          title="Copy Text"
          icon={Icon.Text}
          shortcut={Keyboard.Shortcut.Common.Copy}
          content={item.lines.join("\n")}
        />
      ) : null}
      <Action.Open title="Open" target={item.path} />
      <Action.ShowInFinder path={item.path} />
      <Action
        title={`${isPinned ? "Unpin" : "Pin"} ${item.kind === "image" ? "Screenshot" : "Recording"}`}
        icon={isPinned ? Icon.PinDisabled : Icon.Pin}
        shortcut={{ modifiers: ["cmd", "shift"], key: "p" }}
        onAction={onTogglePinned}
      />
      <Action.Trash
        paths={item.path}
        shortcut={{ modifiers: ["ctrl"], key: "x" }}
        onTrash={onTrash}
      />
      <ActionPanel.Section title="Grid">
        {columns > MIN_COLUMNS ? (
          <Action
            title={`Use ${columns - 1} Columns`}
            shortcut={{ modifiers: ["cmd"], key: "-" }}
            onAction={() => changeColumns(-1)}
          />
        ) : null}
        {columns < MAX_COLUMNS ? (
          <Action
            title={`Use ${columns + 1} Columns`}
            shortcut={{ modifiers: ["cmd"], key: "+" }}
            onAction={() => changeColumns(1)}
          />
        ) : null}
        <Action
          title="Reset Columns"
          shortcut={{ modifiers: ["cmd"], key: "0" }}
          onAction={resetColumns}
        />
      </ActionPanel.Section>
      <ActionPanel.Section title="Settings">
        <Action
          title="Add Search Scope"
          icon={Icon.Folder}
          onAction={addScope}
        />
        <Action
          title="Open Screenshot Settings"
          icon={Icon.Gear}
          onAction={openExtensionPreferences}
        />
      </ActionPanel.Section>
    </ActionPanel>
  );
}

function GridActions({
  columns,
  resetColumns,
  changeColumns,
  addScope,
}: GridActionsProps) {
  return (
    <ActionPanel>
      <Action title="Add Search Scope" icon={Icon.Folder} onAction={addScope} />
      <Action
        title="Open Screenshot Settings"
        icon={Icon.Gear}
        onAction={openExtensionPreferences}
      />
      <ActionPanel.Section title="Grid">
        {columns > MIN_COLUMNS ? (
          <Action
            title={`Use ${columns - 1} Columns`}
            shortcut={{ modifiers: ["cmd"], key: "-" }}
            onAction={() => changeColumns(-1)}
          />
        ) : null}
        {columns < MAX_COLUMNS ? (
          <Action
            title={`Use ${columns + 1} Columns`}
            shortcut={{ modifiers: ["cmd"], key: "+" }}
            onAction={() => changeColumns(1)}
          />
        ) : null}
        <Action
          title="Reset Columns"
          shortcut={{ modifiers: ["cmd"], key: "0" }}
          onAction={resetColumns}
        />
      </ActionPanel.Section>
    </ActionPanel>
  );
}

async function pasteFile(filePath: string, name: string): Promise<void> {
  try {
    await Clipboard.paste({ file: filePath });
    await showToast({
      style: Toast.Style.Success,
      title: "Pasted",
      message: name,
    });
  } catch (error) {
    await showToast({
      style: Toast.Style.Failure,
      title: "Could Not Paste File",
      message:
        error instanceof Error ? error.message : "The file could not be pasted",
    });
  }
}

function clampColumns(value: number): number {
  return Number.isFinite(value)
    ? Math.min(MAX_COLUMNS, Math.max(MIN_COLUMNS, value))
    : DEFAULT_COLUMNS;
}
