// Summarises long-benchmark runs as a Markdown table, with a mean row per
// build (the label up to its first hyphen, e.g. base-1 and base-2).
//
//   node test/manual-long-benchmark-summary.mjs RESULTS/base-1 RESULTS/new-1 ...
//
// Each directory holds report.json from test/manual-long-benchmark.mjs and,
// for wrapped runs, wrapper.json and sglang-delta.json. Values the run did not
// record are shown as "unknown"; values that do not apply to the task as
// "n/a". Neither is counted as zero, and means use only known values.
import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const UNKNOWN = "unknown";
const NA = "n/a";

// One counter from sglang-delta.json; older files used doubled mode keys.
function counter(delta, name, mode) {
  if (!delta || delta.unavailable) return null;
  const value = delta[`${name}:${mode}`] ?? delta[`${name}:${mode}:${mode}`];
  return typeof value === "number" ? value : null;
}

// A token sum is a number only when every request reported it.
function tokenCell(tokens, field) {
  if (!tokens || typeof tokens.requests !== "number") return UNKNOWN;
  const reported = tokens[`${field}Reported`],
    sum = tokens[`${field}Sum`];
  if (!reported) return `${UNKNOWN} (0/${tokens.requests} reported)`;
  if (reported < tokens.requests)
    return `>= ${sum} (${reported}/${tokens.requests} reported)`;
  return sum;
}

function failuresByTool(report) {
  let byTool = report.toolFailuresByTool;
  if (!byTool && report.toolFailures) {
    byTool = {};
    for (const [key, n] of Object.entries(report.toolFailures)) {
      const name = key.split(":", 1)[0];
      byTool[name] = (byTool[name] ?? 0) + n;
    }
  }
  if (!byTool) return UNKNOWN;
  const entries = Object.entries(byTool).sort((a, b) => b[1] - a[1]);
  return entries.length
    ? entries.map(([name, n]) => `${name} ${n}`).join(", ")
    : "none";
}

// The PLAN-04 verdict with the hidden play-through checks behind it. A
// verdict without counts, or no verdict, is shown with its reason.
function hiddenCell(hidden) {
  if (hidden === null) return NA;
  if (!hidden || typeof hidden !== "object") return UNKNOWN;
  if (typeof hidden.passed === "number")
    return (
      (hidden.verdict ? `${hidden.verdict}: ` : "") +
      `${hidden.passed} passed, ${hidden.failed} failed` +
      (hidden.unavailable ? `, ${hidden.unavailable} unavailable` : "")
    );
  return hidden.verdict
    ? `${hidden.verdict}${hidden.reason ? ` (${hidden.reason})` : ""}`
    : UNKNOWN;
}

function playtestCell(playtest) {
  if (playtest === null) return NA;
  if (typeof playtest === "boolean") return playtest ? "yes" : "no";
  if (!playtest || typeof playtest !== "object") return UNKNOWN;
  if (playtest.observed === true)
    return playtest.afterLastEdit === false ? "yes (before last edit)" : "yes";
  if (playtest.observed === false) return "no";
  return `${UNKNOWN}${playtest.reason ? ` (${playtest.reason})` : ""}`;
}

export function summaryRow(label, report, wrapper = null, delta = null) {
  const suite = report.finalSuite;
  const hidden = report.hiddenChecks;
  const view = report.viewImage;
  const playtest = report.unpromptedPlaytest;
  const contended = wrapper?.contention?.contended;
  return {
    label,
    build: label.split("-")[0],
    hidden: hiddenCell(hidden),
    suite:
      typeof suite?.passed === "number"
        ? `${suite.passed}/${suite.expected}`
        : UNKNOWN,
    suitePassed: typeof suite?.passed === "number" ? suite.passed : null,
    rounds: report.logicalRounds ?? report.codingRequests ?? null,
    turns: report.turns?.length ?? null,
    tools: report.toolCallsTotal ?? null,
    failed: report.toolFailuresTotal ?? null,
    failedByTool: failuresByTool(report),
    commandExits: report.nonzeroCommandExits ?? null,
    checkpointBlocks: report.checkpointBlocks ?? null,
    prompt: tokenCell(report.tokens, "prompt"),
    completion: tokenCell(report.tokens, "completion"),
    peak: report.peakContextTokens ?? null,
    viewImage: view
      ? view.calls
        ? `${view.calls} (${view.failed} failed)`
        : "no"
      : UNKNOWN,
    playtest: playtestCell(playtest),
    prefill: counter(delta, "prefill_effective_tokens_total", "input"),
    cacheHit: counter(delta, "prefill_effective_tokens_total", "device_hit"),
    decode: counter(delta, "realtime_tokens_total", "decode"),
    contended:
      contended === true ? "YES" : contended === false ? "no" : UNKNOWN,
    compactions:
      report.session?.compaction?.count ?? report.notices?.compacted ?? null,
    masks: report.maskBatches?.length ?? null,
    done:
      report.doneRule === undefined
        ? UNKNOWN
        : report.doneRule.fullSuiteAfterLastEdit
          ? "yes"
          : "no",
    unchanged:
      report.tablesUnchanged === undefined
        ? UNKNOWN
        : report.tablesUnchanged && report.testsUnchanged
          ? "yes"
          : "NO",
    minutes:
      typeof report.elapsedMs === "number" ? report.elapsedMs / 60000 : null,
    stop:
      String(report.stopReason) +
      (report.timedOut ? " (timeout)" : "") +
      (report.error ? " ERR" : ""),
  };
}

const COLUMNS = [
  ["label", "run"],
  ["hidden", "hidden checks"],
  ["suite", "suite pass"],
  ["rounds", "rounds"],
  ["turns", "turns"],
  ["tools", "tool calls"],
  ["failed", "failed calls"],
  ["failedByTool", "failed by tool"],
  ["commandExits", "non-zero exits"],
  ["checkpointBlocks", "checkpoint blocks"],
  ["prompt", "prompt tok"],
  ["completion", "completion tok"],
  ["peak", "peak ctx"],
  ["viewImage", "view_image"],
  ["playtest", "unprompted play-test"],
  ["prefill", "prefill computed"],
  ["cacheHit", "prefix-cache hit"],
  ["decode", "decode tok"],
  ["contended", "other load"],
  ["compactions", "compactions"],
  ["masks", "mask batches"],
  ["done", "suite after last edit"],
  ["unchanged", "tables/tests unchanged"],
  ["minutes", "wall min"],
  ["stop", "stop"],
];

const cell = (key, value) =>
  value === null || value === undefined
    ? UNKNOWN
    : typeof value === "number"
      ? key === "minutes"
        ? value.toFixed(1)
        : String(Math.round(value))
      : String(value);

export function markdown(rows) {
  const line = (cells) => "| " + cells.join(" | ") + " |";
  const out = [
    line(COLUMNS.map((c) => c[1])),
    line(COLUMNS.map(() => "---")),
    ...rows.map((r) => line(COLUMNS.map(([k]) => cell(k, r[k])))),
  ];
  for (const build of [...new Set(rows.map((r) => r.build))]) {
    const group = rows.filter((r) => r.build === build);
    const mean = (key) => {
      const values = group
        .map((r) => r[key])
        .filter((v) => typeof v === "number");
      if (!values.length) return UNKNOWN;
      const m = values.reduce((a, b) => a + b, 0) / values.length;
      const text =
        key === "minutes" ? m.toFixed(1) : String(Math.round(m * 10) / 10);
      return values.length < group.length
        ? `${text} (n=${values.length})`
        : text;
    };
    out.push(
      line(
        COLUMNS.map(([k]) =>
          k === "label"
            ? `**${build} mean (n=${group.length})**`
            : k === "suite"
              ? mean("suitePassed")
              : group.some((r) => typeof r[k] === "number")
                ? mean(k)
                : "",
        ),
      ),
    );
  }
  return out.join("\n");
}

function readJson(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const directories = process.argv.slice(2);
  if (!directories.length) {
    console.error(
      "Usage: node test/manual-long-benchmark-summary.mjs RUN_DIRECTORY...",
    );
    process.exitCode = 2;
  } else {
    const rows = directories.map((directory) => {
      const report = readJson(join(directory, "report.json"));
      if (!report) throw new Error(`No report.json in ${directory}`);
      return summaryRow(
        basename(resolve(directory)),
        report,
        readJson(join(directory, "wrapper.json")),
        readJson(join(directory, "sglang-delta.json")),
      );
    });
    console.log(markdown(rows));
  }
}
