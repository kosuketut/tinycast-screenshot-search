/// <reference types="@raycast/api">

/* 🚧 🚧 🚧
 * This file is auto-generated from the extension's manifest.
 * Do not modify manually. Instead, update the `package.json` file.
 * 🚧 🚧 🚧 */

/* eslint-disable @typescript-eslint/ban-types */

type ExtensionPreferences = {
  /** Search Scopes - Extra folders to scan, one per line. The system screenshot folder, the CleanShot X folder, and Desktop are always included. */
  "scopeFolders": string,
  /** Include All Media - Index all supported images and videos in watched folders. */
  "includeAllMedia": boolean,
  /** Text Recognition - Read the text in screenshots with Vision on this Mac, newest first. */
  "textRecognition": boolean,
  /** Allow Text Recognition for Cloud Files - Let macOS download cloud-only files to read their text. */
  "allowCloudFiles": boolean,
  /** Read Screenshots From - Only read the text of screenshots this recent. Original files are never deleted. */
  "storageDuration": "1d" | "1w" | "1m" | "3m" | "6m" | "1y" | "unlimited",
  /** Column Count - Default number of columns in the screenshot grid. */
  "columnCount": "3" | "4" | "5" | "6"
}

/** Preferences accessible in all the extension's commands */
declare type Preferences = ExtensionPreferences

declare namespace Preferences {
  /** Preferences accessible in the `search-screenshots` command */
  export type SearchScreenshots = ExtensionPreferences & {}
  /** Preferences accessible in the `paste-latest-screenshot` command */
  export type PasteLatestScreenshot = ExtensionPreferences & {}
  /** Preferences accessible in the `index-screenshots` command */
  export type IndexScreenshots = ExtensionPreferences & {}
}

declare namespace Arguments {
  /** Arguments passed to the `search-screenshots` command */
  export type SearchScreenshots = {}
  /** Arguments passed to the `paste-latest-screenshot` command */
  export type PasteLatestScreenshot = {}
  /** Arguments passed to the `index-screenshots` command */
  export type IndexScreenshots = {}
}

