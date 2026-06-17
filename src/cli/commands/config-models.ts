import { defaultRegistry } from "../../models/registry.ts";

export async function configModelsCommand(): Promise<void> {
  const profiles = defaultRegistry.list();

  process.stdout.write("Available model profiles:\n");

  for (const p of profiles) {
    const reasoningPart = p.reasoningTags ? `  reasoning=${p.reasoningTags.open}` : "";
    const line = `  ${p.id.padEnd(22)} — ${p.label.padEnd(40)} ctx=${p.contextWindow}  temp=${p.samplingDefaults.temperature}${reasoningPart}`;
    process.stdout.write(`${line}\n`);
  }
}
