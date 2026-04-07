"use strict";

/**
 * stop-listener.js
 *
 * Remote-stop feature for the keepalive runner.
 *
 * Cơ chế: mỗi runner ghi unique ID của mình lên Firebase khi khởi động.
 * Khi có runner mới ghi đè giá trị đó, runner cũ nhận SSE event thấy
 * giá trị ≠ STOP_RUNNER_ID của mình → tự động chạy stop sequence.
 *
 * Environment variables:
 *
 *   STOP_LISTENER_ENABLED   "true" to activate (default: false)
 *   STOP_FIREBASE_URL       Full Firebase REST URL incl. path + ?auth=SECRET
 *   STOP_RUNNER_ID          Unique value of THIS runner (set at the top of your CI flow)
 *   STOP_POLL_INTERVAL_MS   Reconnect delay on SSE failure in ms (default: 5000)
 */

// ─── Guard: stop sequence fires only once ─────────────────────────────────────
let _stopSequenceTriggered = false;

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Call once at keepalive startup (non-blocking, fire-and-forget).
 * 1. Writes STOP_RUNNER_ID to Firebase to claim ownership.
 * 2. Opens an SSE connection; stops this runner if the value changes.
 *
 * Does nothing if STOP_LISTENER_ENABLED !== "true".
 */
async function startStopListener(options = {}) {
  if (process.env.STOP_LISTENER_ENABLED !== "true") return;

  const firebaseUrl = normalizeFirebaseRestUrl(process.env.STOP_FIREBASE_URL || "");
  const runnerId = options.runnerId || process.env.STOP_RUNNER_ID;

  if (!firebaseUrl) {
    console.warn("[stop-listener] STOP_FIREBASE_URL not set, skipping.");
    return;
  }

  if (!runnerId) {
    console.warn("[stop-listener] STOP_RUNNER_ID not set, skipping.");
    return;
  }

  // ── Step 1: Claim ownership — write our ID to Firebase ──────────────────────
  const claimed = await _claimOwnership(firebaseUrl, runnerId);
  if (!claimed) {
    // Non-fatal: still start the listener so we can detect a takeover.
    console.warn("[stop-listener] Could not write STOP_RUNNER_ID to Firebase, continuing anyway.");
  }

  // ── Step 2: Start SSE listener ───────────────────────────────────────────────
  console.log(`[stop-listener] Starting SSE listener (runner ID: "${runnerId}")…`);
  _connectSSE(firebaseUrl, runnerId);
}

// ─── Claim ownership ──────────────────────────────────────────────────────────

/**
 * Write this runner's ID to Firebase via HTTP PUT.
 * Uses https built-in — no extra packages needed.
 *
 * @param {string} url       Full Firebase REST URL
 * @param {string} runnerId  The unique value to write
 * @returns {Promise<boolean>} true on success
 */
function _claimOwnership(url, runnerId) {
  return new Promise((resolve) => {
    const https = require("https");

    let urlObj;
    try {
      urlObj = new URL(url);
    } catch {
      console.error("[stop-listener] Invalid STOP_FIREBASE_URL.");
      return resolve(false);
    }

    const body = JSON.stringify(runnerId);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      if (res.statusCode && [301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        const redirected = new URL(res.headers.location, urlObj).toString();
        _claimOwnership(redirected, runnerId).then(resolve);
        return;
      }

      res.resume(); // drain response body
      if (res.statusCode && res.statusCode < 300) {
        console.log(`[stop-listener] Claimed ownership on Firebase (HTTP ${res.statusCode}).`);
        resolve(true);
      } else {
        console.warn(`[stop-listener] Firebase PUT returned HTTP ${res.statusCode}.`);
        resolve(false);
      }
    });

    req.on("error", (err) => {
      console.warn("[stop-listener] Firebase PUT error:", err.message);
      resolve(false);
    });

    req.write(body);
    req.end();
  });
}

// ─── SSE connection ───────────────────────────────────────────────────────────

/**
 * Open an SSE connection to Firebase REST (text/event-stream).
 * Triggers stop if the received value differs from this runner's ID.
 * Reconnects automatically on error or premature close.
 *
 * @param {string} url       Full Firebase REST URL
 * @param {string} runnerId  This runner's unique ID
 */
function _connectSSE(url, runnerId) {
  if (_stopSequenceTriggered) return;

  const https = require("https");

  let urlObj;
  try {
    urlObj = new URL(url);
  } catch (e) {
    console.error("[stop-listener] Invalid STOP_FIREBASE_URL:", e.message);
    return;
  }

  const reconnectDelay = Math.max(1000, parseInt(process.env.STOP_POLL_INTERVAL_MS ?? "5000", 10) || 5000);

  const options = {
    hostname: urlObj.hostname,
    path: urlObj.pathname + urlObj.search,
    method: "GET",
    headers: {
      Accept: "text/event-stream",
      "Cache-Control": "no-cache",
    },
  };

  const req = https.request(options, (res) => {
    if (res.statusCode && [301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
      const redirected = new URL(res.headers.location, urlObj).toString();
      console.log(`[stop-listener] SSE redirected to: ${redirected}`);
      res.resume();
      _connectSSE(redirected, runnerId);
      return;
    }

    if (res.statusCode && res.statusCode >= 400) {
      console.error(`[stop-listener] SSE endpoint returned HTTP ${res.statusCode}. ` + "Check STOP_FIREBASE_URL / auth secret. Retrying in 30 s…");
      res.resume();
      setTimeout(() => _connectSSE(url, runnerId), 30_000);
      return;
    }

    console.log(`[stop-listener] SSE connected (HTTP ${res.statusCode}).`);

    let buffer = "";

    res.on("data", (chunk) => {
      if (_stopSequenceTriggered) return;

      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop(); // keep incomplete trailing line

      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        try {
          const raw = line.replace(/^data:\s*/, "");

          // Firebase sends null on initial connect — ignore
          if (raw === "null" || raw === "") continue;

          // Firebase SSE payload: { "path": "/", "data": <value> }
          const payload = JSON.parse(raw);
          const value = payload?.data;

          // Ignore null / missing values (no one has claimed ownership yet)
          if (value === null || value === undefined || value === "") continue;

          // ── Core logic: stop if value is no longer ours ──────────────────
          if (value !== runnerId) {
            console.log(`[stop-listener] Ownership taken: "${value}" ≠ own ID "${runnerId}" — triggering stop.`);
            if (!_stopSequenceTriggered) {
              _stopSequenceTriggered = true;
              executeStopSequence(); // intentionally not awaited
            }
          }
        } catch {
          // Silently swallow JSON parse errors
        }
      }
    });

    let reconnectScheduled = false;
    const scheduleReconnect = (reason) => {
      if (_stopSequenceTriggered || reconnectScheduled) return;
      reconnectScheduled = true;
      console.warn(`[stop-listener] SSE ${reason}, reconnecting in ${reconnectDelay / 1000} s…`);
      setTimeout(() => _connectSSE(url, runnerId), reconnectDelay);
    };

    res.on("end", () => {
      scheduleReconnect("connection ended");
    });

    res.on("close", () => {
      scheduleReconnect("connection closed");
    });

    res.on("error", (err) => {
      if (_stopSequenceTriggered) return;
      console.warn(`[stop-listener] SSE response error: ${err.message}`);
      scheduleReconnect("response error");
    });
  });

  req.on("error", (err) => {
    if (_stopSequenceTriggered) return;
    console.warn(`[stop-listener] SSE error: ${err.message} — retrying in ${reconnectDelay / 1000} s`);
    setTimeout(() => _connectSSE(url, runnerId), reconnectDelay);
  });

  req.end();
}

/**
 * Firebase REST Database endpoints must end with `.json`.
 * Accepts URLs with/without `.json` and returns normalized URL.
 */
function normalizeFirebaseRestUrl(rawUrl) {
  if (!rawUrl) return "";
  try {
    const u = new URL(rawUrl);
    if (!u.pathname.endsWith(".json")) {
      u.pathname = `${u.pathname.replace(/\/+$/, "")}.json`;
    }
    return u.toString();
  } catch {
    return rawUrl;
  }
}

// ─── Stop sequence ────────────────────────────────────────────────────────────

/**
 * Execute all stop steps in order.
 * Every step is wrapped in its own try/catch — a failure NEVER aborts the sequence.
 * Calls process.exit(0) after all steps complete.
 */
async function executeStopSequence() {
  console.log("[stop] ==== BEGIN STOP SEQUENCE ====");

  // ── Step 1: docker compose down -v ──────────────────────────────────────────
  try {
    const { execSync } = require("child_process");
    console.log("[stop] [1] docker compose down -v …");
    execSync("docker compose down -v", { stdio: "inherit", timeout: 30_000 });
    console.log("[stop] [1] docker compose down done.");
  } catch (e) {
    console.warn("[stop] [1] docker compose down failed:", e.message);
  }

  // ── Step 2a: GitHub Actions API cancel ──────────────────────────────────────
  try {
    if (process.env.GITHUB_ACTIONS) {
      console.log("[stop] [2a] GitHub Actions API cancel…");
      const [owner, repo] = (process.env.GITHUB_REPOSITORY ?? "").split("/");
      const runId = process.env.GITHUB_RUN_ID;
      const token = process.env.GITHUB_TOKEN;

      if (owner && repo && runId && token) {
        const fetchFn = _getFetch();
        if (fetchFn) {
          const res = await fetchFn(`https://api.github.com/repos/${owner}/${repo}/actions/runs/${runId}/cancel`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "X-GitHub-Api-Version": "2022-11-28",
            },
          });
          console.log("[stop] [2a] GitHub cancel status:", res.status);
        } else {
          console.warn("[stop] [2a] fetch not available (Node < 18), skipping.");
        }
      } else {
        console.warn("[stop] [2a] Missing GitHub env vars, skipping.");
      }
    }
  } catch (e) {
    console.warn("[stop] [2a] GitHub API cancel failed:", e.message);
  }

  // ── Step 2b: Azure Pipelines API cancel ─────────────────────────────────────
  try {
    if (process.env.TF_BUILD) {
      console.log("[stop] [2b] Azure Pipelines API cancel…");
      const org = process.env.SYSTEM_TEAMFOUNDATIONCOLLECTIONURI;
      const proj = process.env.SYSTEM_TEAMPROJECT;
      const bid = process.env.BUILD_BUILDID;
      const tok = process.env.SYSTEM_ACCESSTOKEN;

      if (org && proj && bid && tok) {
        const fetchFn = _getFetch();
        if (fetchFn) {
          const basic = Buffer.from(`:${tok}`).toString("base64");
          const res = await fetchFn(`${org}${proj}/_apis/build/builds/${bid}?api-version=7.1`, {
            method: "PATCH",
            headers: {
              Authorization: `Basic ${basic}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ status: "cancelling" }),
          });
          console.log("[stop] [2b] Azure cancel status:", res.status);
        } else {
          console.warn("[stop] [2b] fetch not available (Node < 18), skipping.");
        }
      } else {
        console.warn("[stop] [2b] Missing Azure env vars, skipping.");
      }
    }
  } catch (e) {
    console.warn("[stop] [2b] Azure API cancel failed:", e.message);
  }

  // ── Step 3: cgroup kill (Linux) ──────────────────────────────────────────────
  try {
    console.log("[stop] [3] Cgroup kill…");
    const fs = require("fs");
    const cgroupContent = fs.readFileSync("/proc/self/cgroup", "utf8");
    const cgroupLine = cgroupContent
      .split("\n")
      .find((l) => l.startsWith("0::"))
      ?.split(":")
      .pop()
      ?.trim();

    if (!cgroupLine) throw new Error("cgroup v2 entry not found");

    const procsFile = `/sys/fs/cgroup${cgroupLine}/cgroup.procs`;
    const pids = fs
      .readFileSync(procsFile, "utf8")
      .split("\n")
      .filter(Boolean)
      .map(Number)
      .filter((p) => p !== process.pid);

    console.log(`[stop] [3] Cgroup PIDs to kill: ${pids.join(", ") || "(none)"}`);
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already dead */
      }
    }
  } catch (e) {
    console.warn("[stop] [3] Cgroup kill failed:", e.message);
  }

  // ── Step 4: process group kill ───────────────────────────────────────────────
  try {
    console.log("[stop] [4] Process group kill…");
    const { execSync } = require("child_process");
    const pgidRaw = execSync(`ps -o pgid= -p ${process.pid}`).toString().trim();
    const pgid = parseInt(pgidRaw, 10);

    if (!Number.isFinite(pgid) || pgid <= 0) {
      throw new Error(`Could not parse PGID from: "${pgidRaw}"`);
    }

    console.log(`[stop] [4] Sending SIGTERM to PGID ${pgid}…`);
    try {
      process.kill(-pgid, "SIGTERM");
    } catch {
      /* may already be gone */
    }

    await new Promise((r) => setTimeout(r, 2_000));

    console.log(`[stop] [4] Sending SIGKILL to PGID ${pgid}…`);
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {
      /* may already be gone */
    }
  } catch (e) {
    console.warn("[stop] [4] Process group kill failed:", e.message);
  }

  // ── Final ────────────────────────────────────────────────────────────────────
  console.log("[stop] ==== STOP SEQUENCE COMPLETE — exiting ====");
  process.exit(0);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Return the built-in fetch (Node >= 18) or null (Node < 18).
 * Callers must handle null gracefully — no extra packages installed.
 */
function _getFetch() {
  if (typeof fetch !== "undefined") return fetch;
  return null;
}

// ─── Exports ──────────────────────────────────────────────────────────────────
module.exports = {
  startStopListener,
  executeStopSequence,
};
