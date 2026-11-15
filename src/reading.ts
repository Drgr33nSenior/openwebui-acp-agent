import { basename, matchesGlob } from "node:path";

// read_file returns numbered lines so the model can page through a file and
// point at places in it. A page keeps one read to a few thousand tokens: whole
// files were re-sent in every later request until compaction. Small files still
// come back whole, so the common case stays one call.
export const READ_WHOLE_BYTES = 8192;
// About 4k tokens of typical source. SWE-agent's 100-line window beat whole
// files, but each extra page is an extra model round on a local model; 400 lines
// usually holds a whole class or module section.
export const READ_PAGE_LINES = 400;
export const READ_MAX_LINES = 2000;
// Bounds a page of long lines (minified or generated text) the line count misses.
export const READ_PAGE_CHARS = 24_000;
export const READ_LINE_CHARS = 2000;
// `12→text`: the number and arrow are not file content. An arrow directly after
// digits at the start of a line is rare in source, unlike a tab (TSV, Makefiles).
export const LINE_MARK = "→";
const prefixed = /^\d+→/;

const fileLines = (text: string) => {
  const lines = text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  return text ? lines : [];
};

export function pageText(text: string, offset?: number, limit?: number) {
  const lines = fileLines(text);
  const total = lines.length;
  if (!total) return "[empty file: 0 lines]";
  // An offset past the end returns the last page instead of failing: the
  // model wanted the end of the file and a failed call costs a round.
  const past = offset !== undefined && offset > total;
  const start = past
    ? Math.max(1, total - (limit ?? READ_PAGE_LINES) + 1)
    : (offset ?? 1);
  const whole =
    offset === undefined &&
    limit === undefined &&
    Buffer.byteLength(text) <= READ_WHOLE_BYTES;
  const count = whole ? total : (limit ?? READ_PAGE_LINES);
  const crlf = text.includes("\r\n");
  const out: string[] = [];
  let chars = 0;
  for (let i = start - 1; i < total && out.length < count; i++) {
    let line = lines[i]!;
    if (crlf && line.endsWith("\r")) line = line.slice(0, -1);
    if (line.length > READ_LINE_CHARS)
      line =
        line.slice(0, READ_LINE_CHARS) +
        ` … [line truncated; ${line.length} characters]`;
    const entry = `${i + 1}${LINE_MARK}${line}`;
    if (!whole && out.length && chars + entry.length + 1 > READ_PAGE_CHARS)
      break;
    out.push(entry);
    chars += entry.length + 1;
  }
  const end = start + out.length - 1;
  const notes = [
    ...(past
      ? [
          `offset ${offset} is past the end; the file has ${total} lines; showing lines ${start}–${end}`,
        ]
      : []),
    `lines ${start}–${end} of ${total}`,
    end < total ? `continue with offset=${end + 1}` : "end of file",
  ];
  if (crlf) notes.push("CRLF line endings, shown without \\r");
  return out.join("\n") + `\n[${notes.join("; ")}]`;
}

// The text without read_file prefixes, when every line carries one. Used only
// to explain a failed edit: a file line can legitimately start with digits and
// an arrow, and a new_string mixes numbered and new lines, so the agent never
// rewrites the model's arguments.
export function withoutLineNumbers(text: string) {
  const lines = text.split("\n");
  const content = lines.filter((line, i) => line || i < lines.length - 1);
  if (!content.length || !content.every((line) => prefixed.test(line)))
    return undefined;
  return lines.map((line) => line.replace(prefixed, "")).join("\n");
}

export const LINE_NUMBER_HINT = `remove read_file's line-number prefixes (for example "12${LINE_MARK}") and use only the file's text`;

export const SEARCH_RESULTS = 50;
export const SEARCH_MAX_RESULTS = 200;
export const SEARCH_LINE_CHARS = 200;
// Counting matches past the shown ones reads the remaining files; stop counting
// here and report a lower bound.
export const SEARCH_COUNT_LIMIT = 1000;

// A glob without "/" matches file names anywhere (like `rg -g`); otherwise it
// matches the workspace-relative path, so `src/**/*.ts` works.
export const globMatch = (path: string, glob: string) =>
  matchesGlob(glob.includes("/") ? path : basename(path), glob);

// One matching line, shortened around the first match.
export function searchLine(line: string, text: string) {
  if (line.endsWith("\r")) line = line.slice(0, -1);
  if (line.length <= SEARCH_LINE_CHARS) return line;
  const at = line.indexOf(text);
  const start = Math.max(0, Math.min(at - 60, line.length - SEARCH_LINE_CHARS));
  const end = start + SEARCH_LINE_CHARS;
  return (
    (start ? "…" : "") + line.slice(start, end) + (end < line.length ? "…" : "")
  );
}

export class SearchResults {
  readonly shown: string[] = [];
  more = 0;
  moreFiles = 0;
  constructor(
    readonly text: string,
    readonly max = SEARCH_RESULTS,
  ) {}
  get done() {
    return this.shown.length + this.more >= SEARCH_COUNT_LIMIT;
  }
  add(path: string, content: string) {
    let hidden = false;
    for (const [i, line] of content.split("\n").entries()) {
      if (this.done) break;
      if (!line.includes(this.text)) continue;
      if (this.shown.length < this.max)
        this.shown.push(`${path}:${i + 1}: ${searchLine(line, this.text)}`);
      else {
        this.more++;
        hidden = true;
      }
    }
    if (hidden) this.moreFiles++;
  }
  format() {
    if (!this.shown.length) return "No matches";
    if (!this.more) return this.shown.join("\n");
    return (
      this.shown.join("\n") +
      `\n[${this.done ? "at least " : ""}${this.more} more matches in ${this.moreFiles} files not shown; narrow with path or glob, or search for longer text]`
    );
  }
}
