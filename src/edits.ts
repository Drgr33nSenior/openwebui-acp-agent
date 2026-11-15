import { createHash } from "node:crypto";

// An existing file above this size is changed with edit_file. write_file sends
// the whole new file as content, so a rewrite at the limit is about 8 KB,
// roughly 2-3k tokens: well inside the default 12,288-token reply even with
// reasoning. Larger rewrites risk a cut-off tool call that never runs.
export const WRITE_FILE_MAX_EXISTING_BYTES = 8192;

export function largeRewriteRefusal(before: string): string | undefined {
  const bytes = Buffer.byteLength(before);
  if (bytes <= WRITE_FILE_MAX_EXISTING_BYTES) return undefined;
  return `write_file replaces whole files; this file is ${Math.round(bytes / 1024)} KB, so a full rewrite risks being cut off by the output limit. Use edit_file for targeted changes (several small calls are fine). write_file is for new files and small files (up to ${WRITE_FILE_MAX_EXISTING_BYTES / 1024} KB). Nothing was written.`;
}

// write_file sends no copy of the current file, so the agent checks staleness
// itself. A session records, per workspace-relative path, the SHA-256 of the
// text read_file last returned (any page: the hash is of the whole file) or the
// agent last wrote. Replacing an existing file needs a record equal to its
// current text. Keys are hashed paths, so the persisted map stays small and
// holds no path text.
export const FILE_VIEW_LIMIT = 512;
export type FileViews = Map<string, string>;
const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");
export const fileViewKey = (relativePath: string) =>
  sha256("path\0" + relativePath);
export const fileViewHash = (text: string) => sha256(text);

export function recordFileView(views: FileViews, key: string, text: string) {
  views.delete(key);
  views.set(key, fileViewHash(text));
  // Oldest first: a file not seen for this long is read again before a rewrite.
  for (const oldest of views.keys()) {
    if (views.size <= FILE_VIEW_LIMIT) break;
    views.delete(oldest);
  }
}

// Why write_file may not replace this existing file yet, if it may not.
export function unseenRewriteRefusal(
  views: FileViews,
  key: string,
  current: string,
  path: string,
): string | undefined {
  const seen = views.get(key);
  if (seen === fileViewHash(current)) return undefined;
  return seen === undefined
    ? `${path} already exists and you have not read it in this session. Read it with read_file before replacing it, or change it with edit_file. Nothing was written.`
    : `${path} changed since you last read or wrote it (in the editor, by a command or by another process). Read it with read_file again before replacing it, so its current content is not lost. Nothing was written.`;
}

export const missingEditTarget = (path: string) =>
  `${path} does not exist; create it with write_file. Nothing was written.`;
export const missingParentFolder = (path: string) =>
  `The folder for ${path} does not exist; create the folder first, then write the file. Nothing was written.`;

// Literal replacement only: no regex, newline normalization or fuzzy matching.
export function replaceText(
  current: string,
  oldString: string,
  newString: string,
  replaceAll = false,
): string {
  if (!oldString) throw new Error("old_string must not be empty");
  let count = 0,
    offset = 0;
  for (;;) {
    const index = current.indexOf(oldString, offset);
    if (index < 0) break;
    count++;
    // Overlapping occurrences are ambiguous too. String replacement below uses
    // standard non-overlapping matches, but uniqueness must not guess a target.
    offset = index + 1;
  }
  if (!count || (count !== 1 && !replaceAll))
    throw new Error(
      `old_string matched ${count} occurrences; ${count ? "expected exactly 1 unless replace_all is true" : "expected at least 1"}. Re-read the file and include more surrounding lines from its current content.`,
    );
  // Build from literal slices; '$&', '$1' and backticks in newString are text.
  const pieces = replaceAll
    ? current.split(oldString)
    : [
        current.slice(0, current.indexOf(oldString)),
        current.slice(current.indexOf(oldString) + oldString.length),
      ];
  const length =
    pieces.reduce((sum, piece) => sum + piece.length, 0) +
    (pieces.length - 1) * newString.length;
  if (length > 100000)
    throw new Error(
      "Resulting file exceeds 100,000 characters; split content into smaller files",
    );
  return pieces.join(newString);
}

// 1-based line of the first difference, for the client's follow-along location.
export function firstChangedLine(before: string | null, after: string): number {
  if (before === null) return 1;
  let index = 0;
  const end = Math.min(before.length, after.length);
  while (index < end && before[index] === after[index]) index++;
  let line = 1;
  for (let i = 0; i < index; i++) if (before[i] === "\n") line++;
  return line;
}
