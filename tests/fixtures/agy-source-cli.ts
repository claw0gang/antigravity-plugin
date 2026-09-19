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
    "--sandbox", "--dangerously-skip-permissions",
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
          { id: "gemini-3.8-flash-low", label: "Gemini 3.8 Flash Low" },
          { id: "gemini-3.8-flash-medium", label: "Gemini 3.8 Flash Medium" },
          { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash High" },
        ],
      },
    },
  }) + "\\n");
  process.exit(0);
}
if (args[args.indexOf("--input-format") + 1] !== "stream-json" ||
    args[args.indexOf("--output-format") + 1] !== "stream-json") {
  throw new Error("fixture requires stream-json input and output");
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
