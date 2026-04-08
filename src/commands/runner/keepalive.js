// Path: src/commands/runner/keepalive.js
const spawn = require("cross-spawn");
const { getStopState, isStopRequested, onStopRequested, startStopListener } = require("./stop-listener");

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

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
      "  --help, -h                  Print this help",
    ].join("\n"),
  );
}

function parsePositiveInteger(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) return fallback;
  return n;
}

function runDockerCommand(args = [], hooks = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    hooks.onStart?.(child);

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

    child.on("error", (err) => {
      hooks.onClose?.(child);
      reject(err);
    });

    child.on("close", (code, signal) => {
      hooks.onClose?.(child);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function runDockerCommandCapture(args = [], hooks = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    hooks.onStart?.(child);

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      hooks.onClose?.(child);
      reject(err);
    });

    child.on("close", (code, signal) => {
      hooks.onClose?.(child);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

async function checkContainerStatus({ composeFile, service, label, hooks = {} }) {
  const psArgs = ["compose", "-f", composeFile, "ps"];
  if (service) psArgs.push(service);

  let result;
  try {
    result = await runDockerCommandCapture(psArgs, hooks);
  } catch (err) {
    console.error(`${label} Warning: could not run docker compose ps: ${err && err.message ? err.message : String(err)}`);
    return { anyRunning: true };
  }

  console.log("┄┄┄ Container Status ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄");
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);

  if (result.code !== 0) {
    if (!(result.signal && (result.signal === "SIGTERM" || result.signal === "SIGINT"))) {
      console.error(`${label} Warning: docker compose ps exited with code ${result.code}.`);
    }
    return { anyRunning: true };
  }

  const lines = result.stdout.split("\n");
  const anyRunning = lines.some((line) => {
    const trimmed = line.trim();
    if (!trimmed || /^NAME\b/i.test(trimmed)) return false;
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

function describeStopState(label, state) {
  if (!state || !state.requested) {
    return `${label} Stop requested.`;
  }

  const parts = [`${label} Stop requested.`];
  if (state.source) parts.push(`source=${state.source}`);
  if (state.reason) parts.push(`reason=${state.reason}`);
  if (state.observedValue !== undefined) parts.push(`observed=${JSON.stringify(state.observedValue)}`);
  if (state.requestedAt) parts.push(`at=${state.requestedAt}`);
  return parts.join(" | ");
}

function killChildProcess(child, label, reason) {
  if (!child || child.exitCode !== null || child.killed) return false;

  const childPid = child.pid;
  console.log(`${label} Aborting in-flight docker command. reason=${reason}${childPid ? ` | pid=${childPid}` : ""}`);

  try {
    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/PID", `${childPid}`, "/T", "/F"], { stdio: "ignore" });
      killer.on("error", () => {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
      });
      return true;
    }

    child.kill("SIGTERM");
    return true;
  } catch (err) {
    console.warn(`${label} Failed to abort docker command: ${err && err.message ? err.message : String(err)}`);
    return false;
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
  let cycleStartedAt = null;
  let activeDockerChild = null;
  let activeDockerKillTimer = null;
  let currentCyclePromise = null;

  const stopPromise = new Promise((resolve) => {
    resolveStop = resolve;
  });

  const clearActiveDocker = (child) => {
    if (!child || activeDockerChild === child) {
      activeDockerChild = null;
    }
    if (activeDockerKillTimer) {
      clearTimeout(activeDockerKillTimer);
      activeDockerKillTimer = null;
    }
  };

  const registerActiveDocker = (child) => {
    activeDockerChild = child;
    if (activeDockerKillTimer) {
      clearTimeout(activeDockerKillTimer);
      activeDockerKillTimer = null;
    }
  };

  const abortActiveDockerIfNeeded = (reason) => {
    const child = activeDockerChild;
    if (!child) return false;

    const terminated = killChildProcess(child, label, reason);
    if (terminated && process.platform !== "win32") {
      activeDockerKillTimer = setTimeout(() => {
        if (activeDockerChild && activeDockerChild === child && activeDockerChild.exitCode === null) {
          try {
            console.warn(`${label} Escalating docker command kill to SIGKILL.`);
            activeDockerChild.kill("SIGKILL");
          } catch {
            /* ignore */
          }
        }
      }, 1000);
      activeDockerKillTimer.unref?.();
    }

    return terminated;
  };

  const stopWithCode = (code = 0, message = "") => {
    if (stopRequested) return;
    stopRequested = true;

    if (timer) {
      clearTimeout(timer);
      timer = null;
    }

    abortActiveDockerIfNeeded(message || "stop requested");

    if (message) console.log(message);
    if (resolveStop) resolveStop(code);
  };

  const stopFromSharedState = () => {
    if (!isStopRequested()) return false;
    const state = getStopState();
    stopWithCode(Number.isInteger(state.exitCode) ? state.exitCode : 130, describeStopState(label, state));
    return true;
  };

  const unsubscribeStop = onStopRequested((state) => {
    stopWithCode(Number.isInteger(state.exitCode) ? state.exitCode : 130, describeStopState(label, state));
  });

  const handleSignal = (signalName) => {
    const baseMessage = isStopRequested()
      ? `${describeStopState(label, getStopState())} | signal=${signalName}`
      : `${label} Received ${signalName}. Shutting down gracefully... Total cycles: ${cycle}`;

    stopWithCode(signalName === "SIGINT" ? 130 : 0, baseMessage);
  };

  const onSigint = () => handleSignal("SIGINT");
  const onSigterm = () => handleSignal("SIGTERM");

  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  await startStopListener({ runnerId: process.env.STOP_RUNNER_ID || "" });
  if (stopFromSharedState()) {
    const exitCode = await stopPromise;
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    unsubscribeStop();
    return exitCode;
  }

  const runCycle = async () => {
    if (running) return;
    if (stopRequested || stopFromSharedState()) return;

    running = true;
    cycle += 1;

    const thisCycleStart = new Date();
    const headerTime = formatTimestamp(thisCycleStart);

    console.log("─────────────────────────────────────────");
    console.log(`${label} ${headerTime} | Cycle #${cycle}`);
    console.log("─────────────────────────────────────────");

    const cmdArgs = ["compose", "-f", composeFile, "logs"];
    if (cycleStartedAt === null) {
      cmdArgs.push(`--tail=${tail}`);
    } else {
      cmdArgs.push(`--since=${cycleStartedAt}`);
      cmdArgs.push(`--tail=${tail}`);
    }
    if (service) cmdArgs.push(service);

    try {
      if (stopRequested || stopFromSharedState()) return;

      let logsOk = true;
      try {
        const result = await runDockerCommand(cmdArgs, {
          onStart: registerActiveDocker,
          onClose: clearActiveDocker,
        });

        if (stopRequested || isStopRequested()) {
          console.log(`${label} docker compose logs interrupted because stop was requested.`);
          return;
        }

        if (result.code !== 0) {
          console.error(`${label} Warning: docker compose logs exited with code ${result.code}.`);
        }
      } catch (err) {
        if (stopRequested || isStopRequested()) {
          console.log(`${label} docker compose logs aborted after stop request.`);
          return;
        }

        if (err && err.code === "ENOENT") {
          console.error(`${label} docker command not found. Please install Docker.`);
          stopWithCode(1, `${label} Stopping because docker command is unavailable.`);
          logsOk = false;
        } else {
          console.error(`${label} Warning: failed to execute docker compose logs: ${err && err.message ? err.message : String(err)}`);
        }
      }

      if (stopRequested || stopFromSharedState()) return;

      if (logsOk) {
        const { anyRunning } = await checkContainerStatus({
          composeFile,
          service,
          label,
          hooks: {
            onStart: registerActiveDocker,
            onClose: clearActiveDocker,
          },
        });

        if (stopRequested || stopFromSharedState()) return;

        if (!anyRunning) {
          stopWithCode(0, `${label} All containers have stopped. Exiting. Total cycles: ${cycle}`);
        }
      }
    } finally {
      cycleStartedAt = toDockerSince(thisCycleStart);
      process.stdout.write("");
      running = false;

      if (!stopRequested && !isStopRequested()) {
        timer = setTimeout(runCycle, interval * 1000);
      }
    }
  };

  currentCyclePromise = runCycle().catch((err) => {
    console.error(`${label} Fatal cycle error: ${err && err.message ? err.message : String(err)}`);
    stopWithCode(1, `${label} Stopping because runCycle crashed.`);
  });

  const exitCode = await stopPromise;

  await Promise.race([
    Promise.resolve(currentCyclePromise).catch(() => undefined),
    wait(1500),
  ]);

  process.off("SIGINT", onSigint);
  process.off("SIGTERM", onSigterm);
  unsubscribeStop();

  return exitCode;
}

module.exports = {
  runKeepalive,
};
