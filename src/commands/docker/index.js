function printDockerHelp() {
  console.log(
    [
      "Usage: dotenvrtdb docker <subcommand> [options]",
      "",
      "No docker subcommands are implemented yet.",
      "This namespace is reserved for future extensions.",
    ].join("\n"),
  );
}

async function runDockerSubcommand(argv = []) {
  const [subcommand] = argv;

  if (!subcommand || subcommand === "-h" || subcommand === "--help") {
    printDockerHelp();
    return 0;
  }

  console.error(`[docker] Unknown subcommand: ${subcommand}`);
  printDockerHelp();
  return 1;
}

module.exports = {
  runDockerSubcommand,
};
