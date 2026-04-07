"use strict";

const { setStopRunnerIdOnRealtime } = require("./stop-listener");

function printHelp() {
  console.log(
    [
      "Usage: dotenvrtdb runner set-stoprunnerid [value]",
      "",
      "Description:",
      "  Ghi STOP_RUNNER_ID lên Firebase Realtime Database (one-shot PUT).",
      "",
      "Arguments:",
      "  value                       Giá trị runner id cần ghi.",
      "                              Nếu không truyền, dùng env STOP_RUNNER_ID.",
      "",
      "Options:",
      "  --help, -h                  Print this help",
    ].join("\n"),
  );
}

async function runSetStopRunnerId(rawArgv = []) {
  const minimist = require("minimist");
  const argv = minimist(rawArgv, {
    alias: { h: "help" },
    string: ["_"],
  });

  if (argv.help) {
    printHelp();
    return 0;
  }

  const runnerIdArg = Array.isArray(argv._) && argv._.length > 0 ? `${argv._[0] || ""}`.trim() : "";
  const runnerId = runnerIdArg || `${process.env.STOP_RUNNER_ID || ""}`.trim();

  if (!runnerId) {
    console.error("[runner set-stoprunnerid] Missing runner id. Pass [value] or set STOP_RUNNER_ID.");
    return 1;
  }

  process.env.STOP_RUNNER_ID = runnerId;
  const ok = await setStopRunnerIdOnRealtime({ runnerId });
  if (!ok) return 1;

  console.log(`[runner set-stoprunnerid] Updated STOP_RUNNER_ID on realtime: \"${runnerId}\"`);
  return 0;
}

module.exports = {
  runSetStopRunnerId,
};
