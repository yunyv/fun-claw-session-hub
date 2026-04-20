export function formatHelpExamples(examples: Array<[command: string, description: string]>) {
  return examples.map(([command, description]) => `  ${command}\n    ${description}`).join("\n");
}
