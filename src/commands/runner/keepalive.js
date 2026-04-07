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

/**
 * Format a Date to an ISO-8601 string accepted by `docker compose logs --since`.
 * Example: "2026-04-05T14:30:00.000Z"
 */
function toDockerSince(date) {
  return date.toISOString();
}

function printHelp() {
  console.log(
    [
      "Usage: dotenvrtdb runner keepalive [options]",
      "",
      "Options:",
      "  --interval, -i <seconds>    Log polling interval in seconds (default: 10)",
      "  --service, -s <name>        docker compose service name (default: all services)",
      "  --tail, -t <lines>          Number of tail lines to fetch on the FIRST cycle (default: 50)",
      "  --compose-file <path>       docker compose file path (default: docker-compose.yml)",
      '  --label <text>              Prefix label for each cycle (default: "[keepalive]")',
      "  --stop-runner-id <value>    Override STOP_RUNNER_ID (fallback: read from env)",
      "  --help, -h                  Print this help",
    ].join("\n"),
  );
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

/**
 * Run a docker command and capture stdout/stderr WITHOUT streaming to process stdout/stderr.
 * Used when we need to inspect the output before (or instead of) printing it.
 */
function runDockerCommandCapture(args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => reject(err));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/**
 * Run `docker compose ps` for the given compose file (and optional service),
 * print the container status table, then return whether any container is still running.
 *
 * "Running" is detected by the STATUS column starting with "Up" which is the standard
 * docker compose ps output format across Compose v2 versions.
 *
 * @returns {{ anyRunning: boolean }}
 */
async function checkContainerStatus({ composeFile, service, label }) {
  const psArgs = ["compose", "-f", composeFile, "ps"];
  if (service) psArgs.push(service);

  let result;
  try {
    result = await runDockerCommandCapture(psArgs);
  } catch (err) {
    // Non-fatal — just skip the check this cycle
    console.error(`${label} Warning: could not run docker compose ps: ${err && err.message ? err.message : String(err)}`);
    return { anyRunning: true }; // assume still running to avoid premature exit
  }

  // ── Print the captured table ──────────────────────────────────────────────
  console.log("┄┄┄ Container Status ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄");
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);

  if (result.code !== 0) {
    console.error(`${label} Warning: docker compose ps exited with code ${result.code}.`);
    return { anyRunning: true }; // cannot determine state reliably
  }

  // ── Detect running containers ─────────────────────────────────────────────
  // docker compose ps STATUS column: "Up X minutes" | "Up X hours" etc.
  // Exited containers show:          "Exited (N) X ago"
  // Header line starts with "NAME"  — skip it.
  const lines = result.stdout.split("\n");
  const anyRunning = lines.some((line) => {
    const trimmed = line.trim();
    if (!trimmed || /^NAME\b/i.test(trimmed)) return false;
    // Match "Up" word in STATUS column
    return /\bUp\b/.test(line);
  });

  return { anyRunning };
}

function detectMissingCompose(message = "") {
  const text = `${message || ""}`.toLowerCase();
  return text.includes("not a docker command") || text.includes('unknown command "compose"') || text.includes("docker-compose is not installed");
}

async function ensureDockerComposeAvailable() {
  try {
    const res = await runDockerCommand(["compose", "version"]);
    if (res.code === 0) return { ok: true };

    const combined = `${res.stdout}\n${res.stderr}`;
    if (detectMissingCompose(combined)) {
      return { ok: false, fatal: true, message: "docker compose is not installed or unavailable. Please install Docker Compose v2." };
    }

    return { ok: true };
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return { ok: false, fatal: true, message: "docker command not found. Please install Docker Desktop/Engine with docker compose." };
    }
    return { ok: false, fatal: true, message: err && err.message ? err.message : String(err) };
  }
}

async function runKeepalive(rawArgv = []) {
  const minimist = require("minimist");
  const argv = minimist(rawArgv, {
    alias: {
      h: "help",
      i: "interval",
      s: "service",
      t: "tail",
    },
    string: ["service", "compose-file", "label", "stop-runner-id"],
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
  const service = typeof argv.service === "string" ? argv.service.trim() : "";
  const composeFile = typeof argv["compose-file"] === "string" && argv["compose-file"].trim() ? argv["compose-file"].trim() : "docker-compose.yml";
  const label = typeof argv.label === "string" && argv.label.trim() ? argv.label.trim() : "[keepalive]";
  const stopRunnerIdArg = typeof argv["stop-runner-id"] === "string" ? argv["stop-runner-id"].trim() : "";

  const availability = await ensureDockerComposeAvailable();
  if (!availability.ok && availability.fatal) {
    console.error(`${label} ${availability.message}`);
    return 1;
  }

  console.log(`${label} Started. Press Ctrl+C to stop. Interval: ${interval}s`);
  console.log(`${label} Start timestamp: ${formatTimestamp()}`);

  // ── Remote-stop listener (non-blocking, fire-and-forget) ──────────────────
  // Priority:
  //   1) CLI --stop-runner-id
  //   2) Existing STOP_RUNNER_ID in environment
  // Then normalize back into process.env.STOP_RUNNER_ID so the listener and
  // downstream checks use the exact same variable name consistently.
  const stopRunnerIdEnvName = "STOP_RUNNER_ID";
  const stopRunnerId = stopRunnerIdArg || process.env[stopRunnerIdEnvName] || "";
  if (stopRunnerId) {
    process.env[stopRunnerIdEnvName] = stopRunnerId;
  }
  startStopListener({ runnerId: process.env[stopRunnerIdEnvName] || "" });

  let cycle = 0;
  let timer = null;
  let running = false;
  let stopRequested = false;
  let resolveStop = null;
  // ISO timestamp recorded at the START of each cycle.
  // Cycle N+1 will use --since=<cycleStartedAt> so only genuinely new lines appear.
  // null = first cycle → use --tail instead.
  let cycleStartedAt = null;

  const stopPromise = new Promise((resolve) => {
    resolveStop = resolve;
  });

  const stopWithCode = (code = 0, message = "") => {
    if (stopRequested) return;
    stopRequested = true;
    if (timer) clearTimeout(timer);
    if (message) console.log(message);
    if (resolveStop) resolveStop(code);
  };

  const shutdown = () => {
    stopWithCode(0, `${label} Shutting down gracefully... Total cycles: ${cycle}`);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const runCycle = async () => {
    if (stopRequested || running) return;
    running = true;
    cycle += 1;

    // Capture the moment this cycle begins BEFORE awaiting docker.
    // The next cycle will use this as its --since boundary.
    const thisCycleStart = new Date();

    const headerTime = formatTimestamp(thisCycleStart);
    console.log("─────────────────────────────────────────");
    console.log(`${label} ${headerTime} | Cycle #${cycle}`);
    console.log("─────────────────────────────────────────");

    // Build log arguments:
    //   • First cycle  → --tail=N   (show recent history on startup)
    //   • Later cycles → --since=<ISO> (show ONLY lines newer than previous cycle start)
    const cmdArgs = ["compose", "-f", composeFile, "logs"];
    if (cycleStartedAt === null) {
      cmdArgs.push(`--tail=${tail}`);
    } else {
      // --no-log-prefix is not used here intentionally; keep service names visible.
      cmdArgs.push(`--since=${cycleStartedAt}`);
      // Also cap with --tail to guard against a burst of lines after a long pause.
      cmdArgs.push(`--tail=${tail}`);
    }
    if (service) cmdArgs.push(service);

    try {
      // ── Step 1: Fetch & print logs ───────────────────────────────────────
      let logsOk = true;
      try {
        const result = await runDockerCommand(cmdArgs);
        if (result.code !== 0) {
          console.error(`${label} Warning: docker compose logs exited with code ${result.code}.`);
        }
      } catch (err) {
        if (err && err.code === "ENOENT") {
          console.error(`${label} docker command not found. Please install Docker.`);
          stopWithCode(1);
          logsOk = false;
        } else {
          console.error(`${label} Warning: failed to execute docker compose logs: ${err && err.message ? err.message : String(err)}`);
        }
      }

      // ── Step 2: Container status check ──────────────────────────────────
      // Run `docker compose ps`, print the status table, and exit if all
      // containers have stopped — no point polling a dead stack.
      if (logsOk && !stopRequested) {
        const { anyRunning } = await checkContainerStatus({ composeFile, service, label });
        if (!anyRunning) {
          stopWithCode(0, `${label} All containers have stopped. Exiting. Total cycles: ${cycle}`);
        }
      }
    } finally {
      // Always update the since-boundary and release the lock, even if an
      // unexpected error escaped the inner try blocks above.
      cycleStartedAt = toDockerSince(thisCycleStart);
      process.stdout.write("");
      running = false;
      if (!stopRequested) {
        timer = setTimeout(runCycle, interval * 1000);
      }
    }
  };

  runCycle();
  const exitCode = await stopPromise;

  process.off("SIGINT", shutdown);
  process.off("SIGTERM", shutdown);

  return exitCode;
}

module.exports = {
  runKeepalive,
};
