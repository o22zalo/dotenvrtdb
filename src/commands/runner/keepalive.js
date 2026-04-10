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
      "  --service, -s <name>        Filter containers by substring match on name (default: all containers)",
      "  --tail, -t <lines>          Number of tail lines to fetch on the FIRST cycle (default: 50)",
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

/**
 * Discover running containers via `docker ps`.
 * Returns an array of { id, name } objects, optionally filtered by service substring.
 * anyRunning is true when docker ps returns at least one container (before filtering).
 */
async function discoverContainers({ service, label, hooks = {} }) {
  let result;
  try {
    result = await runDockerCommandCapture(["ps", "--format", "{{.ID}}\t{{.Names}}"], hooks);
  } catch (err) {
    console.error(`${label} Warning: could not run docker ps: ${err && err.message ? err.message : String(err)}`);
    return { containers: [], anyRunning: true };
  }

  if (result.code !== 0) {
    if (!(result.signal && (result.signal === "SIGTERM" || result.signal === "SIGINT"))) {
      console.error(`${label} Warning: docker ps exited with code ${result.code}.`);
    }
    return { containers: [], anyRunning: true };
  }

  const lines = result.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const anyRunning = lines.length > 0;

  const containers = lines
    .map((line) => {
      const [id, ...nameParts] = line.split("\t");
      return { id: id.trim(), name: nameParts.join("\t").trim() };
    })
    .filter(({ id, name }) => id && name)
    .filter(({ name }) => !service || name.includes(service));

  return { containers, anyRunning };
}

/**
 * Fetch logs for a single container and stream to stdout.
 * Returns { ok, id, name } on completion.
 */
async function fetchContainerLogs({ id, name, since, tail, label, hooks = {} }) {
  const args = ["logs"];
  if (since) {
    args.push(`--since=${since}`);
  }
  args.push(`--tail=${tail}`);
  args.push(id);

  try {
    const result = await runDockerCommand(args, hooks);

    if (result.code !== 0 && !(result.signal && (result.signal === "SIGTERM" || result.signal === "SIGINT"))) {
      console.error(`${label} Warning: docker logs for ${name} (${id}) exited with code ${result.code}.`);
    }

    return { ok: true, id, name };
  } catch (err) {
    if (err && err.code === "ENOENT") {
      throw err; // propagate — docker missing is fatal
    }
    console.warn(`${label} Warning: failed to fetch logs for ${name} (${id}): ${err && err.message ? err.message : String(err)}`);
    return { ok: false, id, name };
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
    string: ["service", "label"],
    default: {
      interval: 10,
      tail: 50,
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
  const label = typeof argv.label === "string" && argv.label.trim() ? argv.label.trim() : "[keepalive]";

  console.log(`${label} Started. Press Ctrl+C to stop. Interval: ${interval}s`);
  console.log(`${label} Start timestamp: ${formatTimestamp()}`);
  if (service) console.log(`${label} Filtering containers by name substring: "${service}"`);

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

    try {
      if (stopRequested || stopFromSharedState()) return;

      // ── 1. Discover running containers ──────────────────────────────────────
      let containers = [];
      let anyRunning = false;

      try {
        const discovery = await discoverContainers({
          service,
          label,
          hooks: { onStart: registerActiveDocker, onClose: clearActiveDocker },
        });
        containers = discovery.containers;
        anyRunning = discovery.anyRunning;
      } catch (err) {
        if (stopRequested || isStopRequested()) {
          console.log(`${label} docker ps aborted after stop request.`);
          return;
        }
        if (err && err.code === "ENOENT") {
          console.error(`${label} docker command not found. Please install Docker.`);
          stopWithCode(1, `${label} Stopping because docker command is unavailable.`);
          return;
        }
        console.error(`${label} Warning: docker ps failed: ${err && err.message ? err.message : String(err)}`);
        // treat as still running so we don't exit prematurely
        anyRunning = true;
      }

      if (stopRequested || stopFromSharedState()) return;

      // ── 2. Fetch logs for each container in parallel ─────────────────────────
      if (containers.length === 0 && anyRunning) {
        console.log(`${label} No containers matched${service ? ` filter "${service}"` : ""}. Skipping log fetch.`);
      } else if (containers.length > 0) {
        console.log(`${label} Fetching logs for ${containers.length} container(s)...`);

        const logTasks = containers.map(({ id, name }) =>
          fetchContainerLogs({
            id,
            name,
            since: cycleStartedAt || null,
            tail,
            label,
            hooks: { onStart: registerActiveDocker, onClose: clearActiveDocker },
          }).catch((err) => {
            // ENOENT (docker missing) — propagate as a rejected result so allSettled captures it
            return Promise.reject(err);
          }),
        );

        const results = await Promise.allSettled(logTasks);

        for (const result of results) {
          if (result.status === "rejected") {
            const err = result.reason;
            if (stopRequested || isStopRequested()) break;
            if (err && err.code === "ENOENT") {
              console.error(`${label} docker command not found. Please install Docker.`);
              stopWithCode(1, `${label} Stopping because docker command is unavailable.`);
              return;
            }
            console.warn(`${label} Warning: unexpected error fetching container logs: ${err && err.message ? err.message : String(err)}`);
          }
        }

        if (stopRequested || isStopRequested()) {
          console.log(`${label} Log fetch interrupted because stop was requested.`);
          return;
        }
      }

      if (stopRequested || stopFromSharedState()) return;

      // ── 3. Print container status summary ────────────────────────────────────
      console.log("┄┄┄ Container Status ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄");
      console.log(`${label} Running containers: ${anyRunning ? `yes (${containers.length} matched)` : "none"}`);

      if (stopRequested || stopFromSharedState()) return;

      if (!anyRunning) {
        stopWithCode(0, `${label} All containers have stopped. Exiting. Total cycles: ${cycle}`);
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

  await Promise.race([Promise.resolve(currentCyclePromise).catch(() => undefined), wait(1500)]);

  process.off("SIGINT", onSigint);
  process.off("SIGTERM", onSigterm);
  unsubscribeStop();

  return exitCode;
}

module.exports = {
  runKeepalive,
};
