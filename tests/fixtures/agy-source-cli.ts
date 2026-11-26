// Generated credential-free child fixture. Its advertised capabilities and
// inventory are simulated; they do not qualify any installed AGY executable.
export const AGY_SOURCE_CLI_PRELUDE = `
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("1.1.28\\n");
  process.exit(0);
}
if (args[0] === "--help") {
  process.stdout.write([
    "--input-format stream-json", "--output-format stream-json",
    "--model <model>", "--conversation <id>", "--print-timeout <duration>",
    "--project <project>", "--new-project", "--add-dir <directory>",
    "--agent <agent>", "--mode <mode>", "--log-file <path>",
    "--sandbox", "--dangerously-skip-permissions", "--settings <json>", "--print <prompt>", "--effort <level>",
  ].join("\\n") + "\\n");
  process.exit(0);
}
const modelsIndex = args.indexOf("models");
if (modelsIndex >= 0) {
  const outputFormatIndex = args.indexOf("--output-format");
  if (outputFormatIndex < 0 || outputFormatIndex >= modelsIndex || args[outputFormatIndex + 1] !== "json") {
    throw new Error("fixture requires global JSON output selection before models");
  }
  for (const flag of ["--project", "--add-dir", "--agent"]) {
    const index = args.indexOf(flag);
    if (index > modelsIndex) throw new Error("fixture requires " + flag + " before models");
  }
  process.stdout.write(JSON.stringify({
    status: "SUCCESS",
    command: {
      name: "models",
      data: {
        models: [
          { id: "gemini-3.8-flash-low", label: "Gemini 3.8 Flash (Low)" },
          { id: "gemini-3.8-flash-medium", label: "Gemini 3.8 Flash (Medium)" },
          { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)" },
        ],
      },
    },
  }) + "\\n");
  process.exit(0);
}
if (args.includes("--print")) {
  if (JSON.parse(args[args.indexOf("--settings") + 1]).disableSlashCommands !== false ||
      args.includes("--conversation") || args.includes("--new-project") || args.includes("--continue")) {
    throw new Error("fixture requires read-only scoped metadata");
  }
  const id = args[args.indexOf("--model") + 1];
  const tiers = ["low", "medium", "high"];
  const variants = Object.fromEntries(tiers.map(tier => [tier, "gemini-3.8-flash-" + tier]));
  const current = tiers.find(tier => variants[tier] === id);
  const command = args[args.indexOf("--print") + 1];
  const effort = args.includes("--effort") ? args[args.indexOf("--effort") + 1] : current;
  if (!current || !tiers.includes(effort) || !["/effort", "/model"].includes(command)) throw new Error("fixture invalid metadata selection");
  if (effort !== current) {
    process.stdout.write(JSON.stringify({ status: "ERROR", conversation_id: "", num_turns: 0, usage: { total_tokens: 0 },
      error: "--model " + id + " conflicts with --effort=" + effort }) + "\\n");
    process.exit(1);
  }
  const name = command.slice(1);
  const label = "Gemini 3.8 Flash (" + current[0].toUpperCase() + current.slice(1) + ")";
  process.stdout.write(JSON.stringify({ status: "SUCCESS", conversation_id: "", num_turns: 0,
    usage: { total_tokens: 0 }, command: { name, data: name === "effort" ? { adjustable: true, current, available: tiers } : { id, label, effort: current, is_default: false } },
    response: name === "model" ? id + "\\t" + label + "\\n" : current + "\\n" }) + "\\n");
  process.exit(0);
}
if (args[args.indexOf("--input-format") + 1] !== "stream-json" ||
    args[args.indexOf("--output-format") + 1] !== "stream-json") {
  throw new Error("fixture requires stream-json input and output");
}
// Reject conflicting inference flags too; unlike the previous fake CLI,
 // the model slug and the selected effort must be compatible.
if (args.includes("--effort")) {
  const model = args[args.indexOf("--model") + 1];
  const effort = args[args.indexOf("--effort") + 1];
  if (model !== "gemini-3.8-flash-" + effort) throw new Error("fixture rejects conflicting inference flags");
}
const input = fs.readFileSync(0, "utf8");
const lines = input.split("\\n");
if (lines.length !== 2 || lines[1] !== "") throw new Error("fixture requires one input line then EOF");
const frame = JSON.parse(lines[0]);
if (frame.event !== "user" || typeof frame.message?.content !== "string") {
  throw new Error("fixture requires a user message");
}
const prompt = frame.message.content;
if (args.includes(prompt) || args.includes("--print")) throw new Error("fixture rejects prompt argv transport");
`;
