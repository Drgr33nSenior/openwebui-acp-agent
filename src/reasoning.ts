import { z } from "zod";
const controls = z.record(
  z.string(),
  z
    .object({
      label: z.string().optional(),
      default: z.string().nullable().optional(),
      options: z.record(
        z.string(),
        z.object({ label: z.string().optional() }).passthrough(),
      ),
    })
    .passthrough(),
);
export type ReasoningChoice = {
  value: string;
  name: string;
  control?: string;
  option?: string;
  effort?: string;
  // The server's declared default for the only offered reasoning control.
  serverDefault?: true;
};
const MODEL_DEFAULT: ReasoningChoice = {
  value: "default",
  name: "Model default",
};
// A declared default must name a declared option. When one control declares
// it, that choice replaces "Model default" so the selector starts on the value
// the server documents instead of an omitted override, which a server may
// resolve differently. Declaration order is kept; nothing is sorted or added.
function withDeclaredDefault(
  options: ReasoningChoice[],
  declared: string | null | undefined,
  key: (choice: ReasoningChoice) => string | undefined,
): ReasoningChoice[] {
  const index =
    declared === null || declared === undefined
      ? -1
      : options.findIndex((c) => key(c) === declared);
  if (index < 0) return [MODEL_DEFAULT, ...options];
  return options.map((c, i) =>
    i === index ? { ...c, serverDefault: true } : c,
  );
}
export function reasoningChoices(model: unknown): ReasoningChoice[] {
  const choices: ReasoningChoice[] = [];
  const m = model as any;
  const parsed = controls.safeParse(m?.info?.params?.model_controls);
  const saved = Object.entries(parsed.success ? parsed.data : {}).filter(
    ([id, c]) => /reason|think/i.test(id + " " + (c.label ?? "")),
  );
  for (const [id, c] of saved) {
    for (const [option, o] of Object.entries(c.options)) {
      choices.push({
        value: JSON.stringify([id, option]),
        name: `${c.label ?? id}: ${o.label ?? option}`,
        control: id,
        option,
      });
    }
  }
  // Explicit workspace model controls take precedence. Provider controls are
  // an additional deployed API contract, not inferred model-family defaults.
  if (choices.length)
    return saved.length === 1
      ? withDeclaredDefault(choices, saved[0]![1].default, (c) => c.option)
      : [MODEL_DEFAULT, ...choices];
  const provider = controls.safeParse(m?.provider_model_controls);
  const effort = provider.success ? provider.data.reasoning_effort : undefined;
  if (effort) {
    for (const [value, option] of Object.entries(effort.options)) {
      choices.push({
        value: JSON.stringify(["reasoning_effort", value]),
        name: `${effort.label ?? "Reasoning effort"}: ${option.label ?? value}`,
        effort: value,
      });
    }
  }
  return withDeclaredDefault(choices, effort?.default, (c) => c.effort);
}
// Initial selection for a new model: the declared default, else Model default.
export function defaultReasoning(choices: ReasoningChoice[]): string {
  return (choices.find((c) => c.serverDefault) ?? MODEL_DEFAULT).value;
}
export function reasoningPayload(
  model: string,
  value: string,
  choices: ReasoningChoice[],
) {
  const choice = choices.find((c) => c.value === value);
  if (!choice) throw new Error("Unsupported reasoning choice for this model");
  if (choice.effort !== undefined) return { reasoning_effort: choice.effort };
  return choice.control
    ? {
        params: {
          model_controls: { [model]: { [choice.control]: choice.option } },
        },
      }
    : {};
}

// Ordered levels of the reasoning_effort request parameter. "none" (thinking
// off) is deliberately absent, so it is never chosen by rank.
const EFFORT_ORDER = ["minimal", "low", "medium", "high", "xhigh", "max"];
// A choice's place in that order; -1 for named workspace controls and values
// outside the standard levels, which have no known order.
export function effortRank(choice: ReasoningChoice): number {
  return choice.effort === undefined ? -1 : EFFORT_ORDER.indexOf(choice.effort);
}
// The declared reasoning_effort choice one level below the given one, or
// undefined at the lowest level and where the order is unknown.
export function lowerEffortChoice(
  choices: ReasoningChoice[],
  value: string,
): ReasoningChoice | undefined {
  const current = choices.find((c) => c.value === value);
  const below = current ? effortRank(current) : -1;
  return choices
    .filter((c) => effortRank(c) >= 0 && effortRank(c) < below)
    .sort((a, b) => effortRank(b) - effortRank(a))[0];
}
