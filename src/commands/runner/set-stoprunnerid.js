const { setStopRunnerIdOnRealtime } = require("./stop-listener");

async function runSetStopRunnerId(rawArgv = []) {
  const minimist = require("minimist");
  const argv = minimist(rawArgv);

  // Lấy ID: Ưu tiên tham số truyền vào > Biến môi trường
  const runnerId = argv._[0] || process.env.STOP_RUNNER_ID || "";

  if (!runnerId) {
    console.error("Error: Runner ID is required. Pass it as an argument or set STOP_RUNNER_ID env.");
    return 1;
  }

  try {
    console.log(`[set-stoprunnerid] Setting Runner ID: ${runnerId}`);
    await setStopRunnerIdOnRealtime({ runnerId });
    console.log(`[set-stoprunnerid] Successfully updated on Firebase.`);
    return 0;
  } catch (err) {
    console.error(`[set-stoprunnerid] Error: ${err.message}`);
    return 1;
  }
}

module.exports = { runSetStopRunnerId };
