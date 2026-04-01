const { runKeepalive } = require("./keepalive");

function printRunnerHelp() {
  console.log(
    [
      "Usage: dotenvrtdb runner <subcommand> [options]",
      "",
      "Available subcommands:",
      "  keepalive    Keep CI runner alive by periodically printing docker compose logs",
      "",
      "Run `dotenvrtdb runner keepalive --help` for details.",
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

  console.error(`[runner] Unknown subcommand: ${subcommand}`);
  printRunnerHelp();
  return 1;
}

module.exports = {
  runRunnerSubcommand,
};
