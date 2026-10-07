# Screenshot Search for Tinycast

Search every screenshot by the text inside it, then preview, copy, or paste it. Built for [Tinycast](https://github.com/abue-ammar/tinycast), which runs Raycast extensions but has no screenshot search of its own. It also runs in Raycast as a development extension.

Text is read on your Mac with Apple's Vision framework (Japanese and English). Nothing leaves the machine. The search model is ported from [gyotaku](https://github.com/xevrion/gyotaku).

## Install in Tinycast

Requires macOS and the Xcode Command Line Tools (`xcode-select --install`), which compile the small OCR helper on first use.

1. Download `screenshot-search.zip` from the [latest release](https://github.com/kosuketut/tinycast-screenshot-search/releases/latest).
2. Unzip it into Tinycast's extensions folder:

   ```sh
   mkdir -p ~/Library/Application\ Support/com.tinycast.app/extensions/screenshot-search
   unzip -o ~/Downloads/screenshot-search.zip -d ~/Library/Application\ Support/com.tinycast.app/extensions/screenshot-search
   ```

3. Restart Tinycast and run **Search Screenshots**. The first run reads every screenshot, newest first; search works on what has been read so far.
4. Optional: enable background runs for **Index Screenshots** so new screenshots are read before you search.

To build it yourself instead: `npm install`, then `npm run build:tinycast`, and copy the contents of `dist/` to the same folder.

In Raycast: `npm install`, then `npm run dev`.

## Commands

- **Search Screenshots**: type anything you remember seeing in a screenshot. Every word must appear in the file name or the recognized text, in any order. Matched lines are shown under each tile.
- **Index Screenshots**: reads the text of new screenshots every 10 minutes in the background, so they are searchable when you open the search.
- **Paste Latest Screenshot**: pastes the newest image into the previously active app.

## Search

| Input | Matches |
|---|---|
| `invoice march` | Screenshots containing both words, on any line. Full-width and half-width characters compare equal. |
| `in:disc` | Screenshots inside a folder whose name starts with `disc`. Quote names with spaces: `in:"my shots"`. |
| `date:today`, `date:yesterday` | That day. |
| `date:week`, `date:month` | The last 7 or 30 days, today included. |
| `date:2026-08-01`, `date:2026-08`, `date:2026` | That day, month, or year. |
| `date:aug` | The most recent August. |
| `before:<when>`, `after:<when>` | Before that date starts, or from it onward. |
| `name:<text>`, `text:<text>` | Only the file name, or only the recognized text. |

A filter that is still being typed, such as `date:yes`, is ignored instead of emptying the results. Words with a colon that are not filters, such as `https://` or `12:30`, are searched as text.

After the exact matches come **Near Matches**: screenshots where OCR read look-alike characters, such as `0RDER` for `order` or `rnodern` for `modern`. Words under four characters only match exactly.

## Actions

| Shortcut | Action |
|---|---|
| Enter | Copy the screenshot |
| Ctrl+Y | Preview, and Ctrl+Y again to go back |
| Cmd+Shift+C | Copy the recognized text |
| Cmd+Shift+P | Pin. Pinned screenshots keep their text regardless of the storage setting. |
| Ctrl+X | Move to the Trash |

## Folders and storage

Configure **Search Scopes** in the extension preferences. The system screenshot folder, the CleanShot X folder, and Desktop are always included.

Without the Xcode Command Line Tools, the extension falls back to Spotlight's text, which is empty for most screenshots. Cloud-only files are skipped unless **Allow Text Recognition for Cloud Files** is on, since reading them makes macOS download them. The recognized text is stored in the extension's support folder. Original files are never modified, except by **Move to Trash**.

Tinycast has no Grid pagination, so results are shown 48 at a time with a **Show More** tile at the end.

## Resource use

Measured on an Apple M3 (24 GB, macOS 27) with 736 screenshots, 718 of them images.

| | Result |
|---|---|
| First full read | About 3 minutes, newest first. Later runs only read new screenshots. |
| OCR helper while reading | One process, up to 256 MB and 1 to 1.6 CPU cores. It exits when reading is done. |
| GPU | No measurable change in utilization while reading. |
| Tinycast with the search open | 217 MB (peak 236 MB), from 35 MB with no extension open. A simple list extension (Kill Process) takes it to 186 MB (peak 208 MB), so this extension adds about 30 MB. |
| Tinycast during the first full read | Up to 229 MB. |
| Stored text | 676 KB for 718 screenshots. |

## Credits

The query syntax (`in:`, `date:`, `before:`, `after:`) and the near-match search for OCR look-alike characters are ported from [gyotaku](https://github.com/xevrion/gyotaku) by xevrion.

## License

[GPL-3.0-or-later](LICENSE), the same license as gyotaku.
