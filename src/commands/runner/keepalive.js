const spawn = require("cross-spawn");
const { startStopListener } = require("./stop-listener");

function formatTimestamp(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

function toDockerSince(date) {
  return date.toISOString();
}

function printHelp() {
  console.log([
    "Usage: dotenvrtdb runner keepalive [options]",
    "",
    "Options:",
    "  --interval, -i <seconds>    Log polling interval in seconds (default: 10)",
    "  --service, -s <name>        docker compose service name (default: all services)",
    "  --tail, -t <lines>          Number of tail lines to fetch on the FIRST cycle (default: 50)",
    "  --compose-file <path>       docker compose file path (default: docker-compose.yml)",
    '  --label <text>              Prefix label for each cycle (default: "[keepalive]")',
    "  --help, -h                  Print this help",
  ].join("\n"));
}

function parsePositiveInteger(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) return fallback;
  return n;
}

function runDockerCommand(args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      process.stdout.write(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(text);
    });
    child.on("error", (err) => reject(err));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function runDockerCommandCapture(args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (err) => reject(err));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function checkContainerStatus({ composeFile, service, label }) {
  const psArgs = ["compose", "-f", composeFile, "ps"];
  if (service) psArgs.push(service);
  try {
    const result = await runDockerCommandCapture(psArgs);
    if (result.stdout) process.stdout.write(result.stdout);
    const lines = result.stdout.split("\n");
    const anyRunning = lines.some((line) => {
      const trimmed = line.trim();
      if (!trimmed || /^NAME\b/i.test(trimmed)) return false;
      return /\bUp\b/.test(line);
    });
    return { anyRunning };
  } catch (err) {
    return { anyRunning: true };
  }
}

async function runKeepalive(rawArgv = []) {
  const minimist = require("minimist");
  const argv = minimist(rawArgv, {
    alias: { h: "help", i: "interval", s: "service", t: "tail" },
    string: ["service", "compose-file", "label"],
    default: {
      interval: 10,
      tail: 50,
      "compose-file": "docker-compose.yml",
      label: "[keepalive]",
    },
  });

  if (argv.help) {
    printHelp();
    return 0;
  }

  const interval = parsePositiveInteger(argv.interval, 10);
  const tail = parsePositiveInteger(argv.tail, 50);
  const service = argv.service || "";
  const composeFile = argv["compose-file"] || "docker-compose.yml";
  const label = argv.label || "[keepalive]";

  // ── STOP_LISTENER setup ────────────────────────────────────────────────────
  // Chỉ lắng nghe theo cấu hình STOP_RUNNER_ID trong env
  const stopRunnerId = process.env.STOP_RUNNER_ID || "";
  if (stopRunnerId) {
    startStopListener({ runnerId: stopRunnerId });
  }

  let cycle = 0;
  let timer = null;
  let running = false;
  let stopRequested = false;
  let resolveStop = null;
  let cycleStartedAt = null;

  const stopPromise = new Promise((resolve) => { resolveStop = resolve; });

  const stopWithCode = (code = 0, message = "") => {
    if (stopRequested) return;
    stopRequested = true;
    if (timer) clearTimeout(timer);
    if (message) console.log(message);
    if (resolveStop) resolveStop(code);
  };

  const shutdown = () => stopWithCode(0, `${label} Shutting down...`);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const runCycle = async () => {
    if (stopRequested || running) return;
    running = true;
    cycle += 1;
    const thisCycleStart = new Date();
    
    console.log("─────────────────────────────────────────");
    console.log(`${label} ${formatTimestamp(thisCycleStart)} | Cycle #${cycle}`);
    
    const cmdArgs = ["compose", "-f", composeFile, "logs"];
    if (cycleStartedAt === null) {
      cmdArgs.push(`--tail=${tail}`);
    } else {
      cmdArgs.push(`--since=${cycleStartedAt}`, `--tail=${tail}`);
    }
    if (service) cmdArgs.push(service);

    try {
      await runDockerCommand(cmdArgs);
      const { anyRunning } = await checkContainerStatus({ composeFile, service, label });
      if (!anyRunning) {
        stopWithCode(0, `${label} All containers stopped.`);
      }
    } finally {
      cycleStartedAt = toDockerSince(thisCycleStart);
      running = false;
      if (!stopRequested) timer = setTimeout(runCycle, interval * 1000);
    }
  };

  runCycle();
  const exitCode = await stopPromise;
  return exitCode;
}

module.exports = { runKeepalive };