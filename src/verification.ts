import { z } from "zod";
import { isAbsolute, relative, resolve } from "node:path";
import { realpath } from "node:fs/promises";
import {
  DEFAULT_COMMAND_TIMEOUT_MS,
  MAX_COMMAND_TIMEOUT_MS,
} from "./commands.js";

const checkCommandSchema = z
  .object({
    executable: z.string().min(1).max(2048),
    args: z.array(z.string().max(4096)).max(64).default([]),
    timeout_ms: z
      .number()
      .int()
      .min(1)
      .max(MAX_COMMAND_TIMEOUT_MS)
      .default(DEFAULT_COMMAND_TIMEOUT_MS),
  })
  .strict();
export const verificationSchema = z
  .object({
    maxFixRounds: z.number().int().min(0).max(5).default(2),
    includeWarnings: z.boolean().default(false),
    maxFiles: z.number().int().min(1).max(10).default(10),
    maxOutputChars: z.number().int().min(1000).max(16000).default(8000),
    projects: z
      .array(
        z
          .object({
            root: z
              .string()
              .max(4096)
              .refine(isAbsolute, "Use an absolute workspace root"),
            commands: z.array(checkCommandSchema).min(1).max(4),
          })
          .strict(),
      )
      .max(64)
      .default([]),
  })
  .strict();
export type VerificationSettings = z.infer<typeof verificationSchema>;

export async function verificationCommands(
  settings: VerificationSettings,
  root: string,
) {
  const matches = [];
  for (const project of settings.projects) {
    if ((await realpath(project.root).catch(() => undefined)) === root)
      matches.push(project);
  }
  if (matches.length > 1)
    throw new Error("Duplicate verification configuration for this workspace");
  return matches[0]?.commands ?? [];
}

export type VerificationResult = {
  text: string;
  failures: boolean;
  unavailable: boolean;
};
export const unavailableVerification = (
  message: string,
): VerificationResult => ({
  text: message,
  failures: false,
  unavailable: true,
});

// Keep control characters, newlines and large source excerpts out of compact
// diagnostics. The remaining text is still untrusted tool output.
const oneLine = (value: string) =>
  value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
export function boundedVerificationText(lines: string[], limit: number) {
  const text = [...new Set(lines)].join("\n");
  const marker = "\n[Verification output truncated]";
  return text.length > limit
    ? text.slice(0, limit - marker.length) + marker
    : text;
}

const problemsSchema = z.object({
  filePath: z.string(),
  errors: z
    .array(
      z.object({
        severity: z.string(),
        description: z.string(),
        line: z.number().int().positive(),
        column: z.number().int().positive(),
      }),
    )
    .max(2000),
  timedOut: z.boolean().nullable().optional(),
});
export function fileProblemsResult(
  raw: string,
  root: string,
  path: string,
  settings: VerificationSettings,
): VerificationResult {
  const label = oneLine(relative(root, path));
  const unavailable = () =>
    unavailableVerification(
      `${label}: IDE diagnostics unavailable or malformed; no clean result established.`,
    );
  try {
    const result = JSON.parse(raw);
    if (result?.isError === true) return unavailable();
    const payload =
      result?.structuredContent ??
      (() => {
        if (
          !Array.isArray(result?.content) ||
          result.content.length !== 1 ||
          result.content[0]?.type !== "text"
        )
          throw new Error();
        return JSON.parse(result.content[0].text);
      })();
    const parsed = problemsSchema.parse(payload);
    if (resolve(root, parsed.filePath) !== path) return unavailable();
    const lines: string[] = [];
    let unknown = false;
    for (const p of parsed.errors) {
      const severity = p.severity.toUpperCase();
      if (
        ![
          "ERROR",
          "WARNING",
          "WEAK_WARNING",
          "WEAK WARNING",
          "INFORMATION",
          "INFO",
        ].includes(severity)
      ) {
        unknown = true;
        continue;
      }
      if (
        severity !== "ERROR" &&
        !(settings.includeWarnings && severity.includes("WARNING"))
      )
        continue;
      lines.push(
        `${label}:${p.line}:${p.column} ${severity} ${oneLine(p.description)}`,
      );
    }
    const failures = lines.length > 0;
    if (parsed.timedOut || unknown)
      lines.push(
        `${label}: IDE analysis incomplete; no clean result established.`,
      );
    return {
      text: boundedVerificationText(
        lines.length ? lines : [`${label}: no selected IDE problems.`],
        settings.maxOutputChars,
      ),
      failures,
      unavailable: parsed.timedOut === true || unknown,
    };
  } catch {
    return unavailable();
  }
}

export function projectCheckResult(
  raw: string,
  label: string,
  limit: number,
): VerificationResult {
  try {
    const value = z
      .object({
        code: z.number().int().nullable(),
        output: z.string(),
        limitedOrCancelled: z.boolean(),
      })
      .parse(JSON.parse(raw));
    const failures = value.code !== 0 || value.limitedOrCancelled;
    return {
      text: boundedVerificationText(
        [
          `${label}: ${failures ? "failed" : "passed"} (exit ${value.code ?? "none"}${value.limitedOrCancelled ? ", limit reached" : ""})`,
          ...value.output.split(/\r?\n/).map(oneLine),
        ],
        limit,
      ),
      failures,
      unavailable: false,
    };
  } catch {
    return unavailableVerification(
      `${label}: check unavailable; no clean result established.`,
    );
  }
}
