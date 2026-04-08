// Path: src/commands/runner/stop-listener.js
"use strict";

/**
 * stop-listener.js
 *
 * Remote-stop feature for the keepalive runner.
 *
 * Environment variables:
 *   STOP_LISTENER_ENABLED   "true" to activate (default: false)
 *   STOP_FIREBASE_URL       Full Firebase REST URL incl. path + ?auth=SECRET
 *   STOP_RUNNER_ID          Unique value of THIS runner
 *   STOP_POLL_INTERVAL_MS   Reconnect delay on SSE failure in ms (default: 5000)
 *   STOP_HEARTBEAT_MS       Max silence before force-reconnect in ms (default: 45000)
 */

// ─── Guard: stop sequence fires only once ─────────────────────────────────────
let _stopSequenceTriggered = false;

// ─── Public API ───────────────────────────────────────────────────────────────

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

  console.log(`[stop-listener] Starting SSE listener (runner ID: "${runnerId}")…`);
  _connectSSE(firebaseUrl, runnerId);
}

async function setStopRunnerIdOnRealtime(options = {}) {
  const firebaseUrl = normalizeFirebaseRestUrl(process.env.STOP_FIREBASE_URL || "");
  const runnerId = options.runnerId || process.env.STOP_RUNNER_ID;

  if (!firebaseUrl) {
    console.warn("[stop-listener] STOP_FIREBASE_URL not set, skip one-shot update.");
    return false;
  }

  if (!runnerId) {
    console.warn("[stop-listener] STOP_RUNNER_ID not set, skip one-shot update.");
    return false;
  }

  return _claimOwnership(firebaseUrl, runnerId);
}

// ─── Claim ownership ──────────────────────────────────────────────────────────

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

      res.resume();
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
  // FIX: heartbeat timeout — if no chunks arrive within this window, assume connection dead
  const heartbeatMs = Math.max(15000, parseInt(process.env.STOP_HEARTBEAT_MS ?? "45000", 10) || 45000);

  const options = {
    hostname: urlObj.hostname,
    path: urlObj.pathname + urlObj.search,
    method: "GET",
    headers: {
      Accept: "text/event-stream",
      "Cache-Control": "no-cache",
      // FIX: tell server to keep connection alive and not compress
      Connection: "keep-alive",
      "Accept-Encoding": "identity",
    },
  };

  let heartbeatTimer = null;
  let activeReq = null;
  let reconnectScheduled = false;

  const scheduleReconnect = (reason) => {
    clearTimeout(heartbeatTimer);
    if (_stopSequenceTriggered || reconnectScheduled) return;
    reconnectScheduled = true;
    console.warn(`[stop-listener] SSE ${reason}, reconnecting in ${reconnectDelay / 1000} s…`);
    setTimeout(() => _connectSSE(url, runnerId), reconnectDelay);
  };

  // FIX: heartbeat watchdog — reset on every data chunk; fire → force-destroy connection
  const resetHeartbeat = () => {
    clearTimeout(heartbeatTimer);
    heartbeatTimer = setTimeout(() => {
      console.warn(`[stop-listener] SSE heartbeat timeout (${heartbeatMs / 1000}s no data) — force reconnect.`);
      if (activeReq) {
        try {
          activeReq.destroy();
        } catch {
          /* ignore */
        }
      }
    }, heartbeatMs);
  };

  const req = https.request(options, (res) => {
    if (res.statusCode && [301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
      clearTimeout(heartbeatTimer);
      const redirected = new URL(res.headers.location, urlObj).toString();
      console.log(`[stop-listener] SSE redirected to: ${redirected}`);
      res.resume();
      _connectSSE(redirected, runnerId);
      return;
    }

    if (res.statusCode && res.statusCode >= 400) {
      clearTimeout(heartbeatTimer);
      console.error(`[stop-listener] SSE endpoint returned HTTP ${res.statusCode}. ` + "Check STOP_FIREBASE_URL / auth secret. Retrying in 30 s…");
      res.resume();
      setTimeout(() => _connectSSE(url, runnerId), 30_000);
      return;
    }

    console.log(`[stop-listener] SSE connected (HTTP ${res.statusCode}). Heartbeat: ${heartbeatMs / 1000}s`);
    resetHeartbeat(); // FIX: start watchdog immediately after connect

    let buffer = "";
    // FIX: track last event type to skip non-put events (keep-alive, cancel)
    let lastEventType = "";

    res.on("data", (chunk) => {
      resetHeartbeat(); // THÊM DÒNG NÀY — reset watchdog mỗi lần có data
      if (_stopSequenceTriggered) return;

      resetHeartbeat(); // FIX: reset watchdog on every chunk — proves connection is alive

      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop(); // keep incomplete trailing line

      for (const line of lines) {
        const trimmed = line.trimEnd(); // FIX: handle \r\n line endings from Firebase

        // FIX: track event type — only process "put" or "patch" data lines
        if (trimmed.startsWith("event:")) {
          lastEventType = trimmed.replace(/^event:\s*/, "").trim();
          continue;
        }

        if (!trimmed.startsWith("data:")) continue;

        // FIX: skip non-data events (keep-alive sends "event: cancel" or "event: keep-alive")
        if (lastEventType && lastEventType !== "put" && lastEventType !== "patch") {
          console.log(`[stop-listener] SSE skipping event type: "${lastEventType}"`);
          lastEventType = "";
          continue;
        }
        lastEventType = ""; // reset after consuming

        try {
          const raw = trimmed.replace(/^data:\s*/, "");

          if (raw === "null" || raw === "") continue;

          const payload = JSON.parse(raw);
          const value = payload?.data;

          console.log(`[stop-listener] SSE received value: ${JSON.stringify(value)}`); // FIX: always log received value

          if (value === null || value === undefined || value === "") continue;

          if (value !== runnerId) {
            console.log(`[stop-listener] Ownership taken: "${value}" ≠ own ID "${runnerId}" — triggering stop.`);
            if (!_stopSequenceTriggered) {
              _stopSequenceTriggered = true;
              clearTimeout(heartbeatTimer);
              executeStopSequence(); // intentionally not awaited
            }
          } else {
            console.log(`[stop-listener] SSE value matches own ID — still owner.`);
          }
        } catch (e) {
          // FIX: was silent catch {} — now warn with details for debugging
          console.warn(`[stop-listener] SSE parse error: ${e.message} | raw: ${trimmed.slice(0, 120)}`);
        }
      }
    });

    res.on("end", () => scheduleReconnect("connection ended"));
    res.on("close", () => scheduleReconnect("connection closed"));
    res.on("error", (err) => {
      if (_stopSequenceTriggered) return;
      console.warn(`[stop-listener] SSE response error: ${err.message}`);
      scheduleReconnect("response error");
    });
  });

  req.on("error", (err) => {
    clearTimeout(heartbeatTimer);
    if (_stopSequenceTriggered) return;
    console.warn(`[stop-listener] SSE request error: ${err.message} — retrying in ${reconnectDelay / 1000} s`);
    setTimeout(() => _connectSSE(url, runnerId), reconnectDelay);
  });
  // THÊM VÀO — ngay trước req.end();
  // FIX: socket-level keepalive so TCP layer sends keepalive probes
  // → prevents silent drops on cloud environments (GitHub Actions, Firebase, etc.)
  req.on("socket", (socket) => {
    socket.setKeepAlive(true, 15_000);
    socket.setTimeout(0);
  });
  req.end();
  activeReq = req; // FIX: keep reference so heartbeat watchdog can destroy it
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

function _getFetch() {
  if (typeof fetch !== "undefined") return fetch;
  return null;
}

// ─── Stop sequence ────────────────────────────────────────────────────────────

async function executeStopSequence() {
  console.log("[stop] ==== BEGIN STOP SEQUENCE ====");

  // Step 1: docker compose down -v
  try {
    const { execSync } = require("child_process");
    console.log("[stop] [1] docker compose down -v …");
    execSync("docker compose down -v", { stdio: "inherit", timeout: 30_000 });
    console.log("[stop] [1] docker compose down done.");
  } catch (e) {
    console.warn("[stop] [1] docker compose down failed:", e.message);
  }

  // Step 2a: GitHub Actions API cancel
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

  // Step 2b: Azure Pipelines API cancel
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

  // Step 3: cgroup kill (Linux)
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

  // Step 4: process group kill
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

  console.log("[stop] ==== STOP SEQUENCE COMPLETE — exiting ====");
  process.exit(0);
}

// ─── Exports ──────────────────────────────────────────────────────────────────
module.exports = {
  startStopListener,
  setStopRunnerIdOnRealtime,
  executeStopSequence,
};
