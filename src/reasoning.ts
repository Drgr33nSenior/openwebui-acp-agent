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
};
export function reasoningChoices(model: unknown): ReasoningChoice[] {
  const choices: ReasoningChoice[] = [
    { value: "default", name: "Model default" },
  ];
  const m = model as any;
  const parsed = controls.safeParse(m?.info?.params?.model_controls);
  for (const [id, c] of Object.entries(parsed.success ? parsed.data : {})) {
    if (!/reason|think/i.test(id + " " + (c.label ?? ""))) continue;
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
  if (choices.length > 1) return choices;
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
  return choices;
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
