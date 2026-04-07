const { runKeepalive } = require("./keepalive");
const { runSetStopRunnerId } = require("./set-stoprunnerid");

function printRunnerHelp() {
  console.log(
    [
      "Usage: dotenvrtdb runner <subcommand> [options]",
      "",
      "Available subcommands:",
      "  keepalive         Keep CI runner alive by periodically printing docker compose logs",
      "  set-stoprunnerid  One-shot update STOP_RUNNER_ID value on realtime",
      "",
      "Run `dotenvrtdb runner <subcommand> --help` for details.",
    ].join("\n"),
  );
}

async function runRunnerSubcommand(argv = []) {
  const [subcommand, ...rest] = argv;

  if (!subcommand || subcommand === "-h" || subcommand === "--help") {
    printRunnerHelp();
    return 0;
  }

  if (subcommand === "keepalive") {
    return runKeepalive(rest);
  }

  if (subcommand === "set-stoprunnerid") {
    return runSetStopRunnerId(rest);
  }

  console.error(`[runner] Unknown subcommand: ${subcommand}`);
  printRunnerHelp();
  return 1;
}

module.exports = {
  runRunnerSubcommand,
};
