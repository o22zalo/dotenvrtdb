const spawn = require("cross-spawn");

function formatTimestamp(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

function printHelp() {
  console.log(
    [
      "Usage: dotenvrtdb runner keepalive [options]",
      "",
      "Options:",
      "  --interval, -i <seconds>    Log polling interval in seconds (default: 10)",
      "  --service, -s <name>        docker compose service name (default: all services)",
      "  --tail, -t <lines>          Number of tail lines to fetch (default: 50)",
      "  --compose-file <path>       docker compose file path (default: docker-compose.yml)",
      '  --label <text>              Prefix label for each cycle (default: "[keepalive]")',
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
  const service = typeof argv.service === "string" ? argv.service.trim() : "";
  const composeFile = typeof argv["compose-file"] === "string" && argv["compose-file"].trim() ? argv["compose-file"].trim() : "docker-compose.yml";
  const label = typeof argv.label === "string" && argv.label.trim() ? argv.label.trim() : "[keepalive]";

  const availability = await ensureDockerComposeAvailable();
  if (!availability.ok && availability.fatal) {
    console.error(`${label} ${availability.message}`);
    return 1;
  }

  console.log(`${label} Started. Press Ctrl+C to stop. Interval: ${interval}s`);
  console.log(`${label} Start timestamp: ${formatTimestamp()}`);

  let cycle = 0;
  let timer = null;
  let running = false;
  let stopRequested = false;
  let resolveStop = null;

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

    const headerTime = formatTimestamp();
    console.log("─────────────────────────────────────────");
    console.log(`${label} ${headerTime} | Cycle #${cycle}`);
    console.log("─────────────────────────────────────────");

    const cmdArgs = ["compose", "-f", composeFile, "logs", `--tail=${tail}`];
    if (service) cmdArgs.push(service);

    try {
      const result = await runDockerCommand(cmdArgs);
      if (result.code !== 0) {
        console.error(`${label} Warning: docker compose logs exited with code ${result.code}.`);
      }
    } catch (err) {
      if (err && err.code === "ENOENT") {
        console.error(`${label} docker command not found. Please install Docker.`);
        stopWithCode(1);
        return;
      }
      console.error(`${label} Warning: failed to execute docker compose logs: ${err && err.message ? err.message : String(err)}`);
    } finally {
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
