# Screenshot Search Changelog

## 1.2.0 - 2026-10-17

- Paste the selected screenshot with Cmd+Enter, in the grid and in the preview.
- Show grid tiles from 512-pixel thumbnails, made for the page shown and the next one. A page of 48 took seconds to fill in in Tinycast.
- List screenshot folders with one `find` instead of a call per file: 3,000 screenshots load in 90 ms instead of 450 ms in Tinycast, which speeds up opening the search and **Paste Latest Screenshot**.

## 1.1.0 - 2026-10-07

- Read screenshot text with Vision (Japanese and English) in the background, newest first, and search it with every query.
- Add an **Index Screenshots** background command that runs every 10 minutes.
- Add `in:`, `before:`, and `after:` filters, and `date:` values `week`, `month`, `2026-08`, `2026`, and month names. Unfinished filters are ignored.
- Add near matches for OCR look-alike characters, shown in their own section.
- Show the matched line under each result, and add **Copy Text** and **Move to Trash** actions.
- Remove the Recognition Mode preference: Spotlight's text was empty for most screenshots.
- Use one OCR process at a time, store the text as an append-only log, and show 48 results at a time in Tinycast, which keeps Tinycast under 240 MB while searching and reading.

## 1.0.0 - 2026-09-20

- Add commands for searching, previewing, copying, and pasting screenshots and screen recordings.
- Add optional Spotlight and Vision OCR with local metadata caching.
