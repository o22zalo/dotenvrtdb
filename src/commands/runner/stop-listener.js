// Path: src/commands/runner/stop-listener.js
"use strict";

/**
 * stop-listener.js
 *
 * Remote-stop feature for the keepalive runner.
 *
 * Environment variables:
 *   STOP_LISTENER_ENABLED      "true" to activate (default: false)
 *   STOP_FIREBASE_URL          Full Firebase REST URL incl. path + ?auth=SECRET
 *   STOP_RUNNER_ID             Unique value of THIS runner
 *   STOP_POLL_INTERVAL_MS      SSE reconnect delay in ms (default: 5000)
 *   STOP_HEARTBEAT_MS          Max silence before force-reconnect in ms (default: 45000)
 *   STOP_VALUE_POLL_INTERVAL_MS Poll interval to verify exact value via GET (default: STOP_POLL_INTERVAL_MS)
 *   STOP_REQUEST_EXIT_CODE     Exit code used when remote stop/ownership loss is detected (default: 0)
 */

let _listenerStarted = false;
let _reconnectTimer = null;
let _pollTimer = null;
let _heartbeatTimer = null;
let _activeSseReq = null;
let _cachedObservedValue;
let _lastObservedLogKey = "";

const _stopCallbacks = new Set();
let _stopState = createInitialStopState();

function createInitialStopState() {
  return {
    requested: false,
    source: "",
    reason: "",
    requestedAt: "",
    observedValue: undefined,
    runnerId: "",
    exitCode: 0,
  };
}

function getStopState() {
  return { ..._stopState };
}

function isStopRequested() {
  return _stopState.requested === true;
}

function onStopRequested(callback) {
  if (typeof callback !== "function") return () => {};
  _stopCallbacks.add(callback);

  if (isStopRequested()) {
    try {
      callback(getStopState());
    } catch (err) {
      console.error(`[stop-listener] stop callback error: ${err && err.message ? err.message : String(err)}`);
    }
  }

  return () => {
    _stopCallbacks.delete(callback);
  };
}

async function startStopListener(options = {}) {
  if (process.env.STOP_LISTENER_ENABLED !== "true") return;

  const firebaseUrl = normalizeFirebaseRestUrl(process.env.STOP_FIREBASE_URL || "");
  const runnerId = `${options.runnerId || process.env.STOP_RUNNER_ID || ""}`.trim();

  if (!firebaseUrl) {
    console.warn("[stop-listener] STOP_FIREBASE_URL not set, skipping.");
    return;
  }

  if (!runnerId) {
    console.warn("[stop-listener] STOP_RUNNER_ID not set, skipping.");
    return;
  }

  if (_listenerStarted) {
    console.log(`[stop-listener] Listener already started (runner ID: "${runnerId}").`);
    return;
  }

  _listenerStarted = true;
  _cachedObservedValue = undefined;
  _lastObservedLogKey = "";

  console.log(`[stop-listener] Starting SSE listener (runner ID: "${runnerId}")…`);
  _connectSSE(firebaseUrl, runnerId);
  _startPolling(firebaseUrl, runnerId);
}

async function setStopRunnerIdOnRealtime(options = {}) {
  const firebaseUrl = normalizeFirebaseRestUrl(process.env.STOP_FIREBASE_URL || "");
  const runnerId = `${options.runnerId || process.env.STOP_RUNNER_ID || ""}`.trim();

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

function parseStopRequestExitCode() {
  const raw = `${process.env.STOP_REQUEST_EXIT_CODE ?? ""}`.trim();
  if (!raw) return 0;

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 255) {
    console.warn(`[stop-listener] Invalid STOP_REQUEST_EXIT_CODE=${JSON.stringify(raw)}. Falling back to 0.`);
    return 0;
  }

  return parsed;
}

function requestStop(options = {}) {
  if (isStopRequested()) return false;

  const source = `${options.source || "unknown"}`.trim() || "unknown";
  const reason = `${options.reason || "Stop requested."}`.trim() || "Stop requested.";
  const runnerId = `${options.runnerId || process.env.STOP_RUNNER_ID || ""}`.trim();

  _stopState = {
    requested: true,
    source,
    reason,
    requestedAt: new Date().toISOString(),
    observedValue: options.observedValue,
    runnerId,
    exitCode: Number.isInteger(options.exitCode) ? options.exitCode : parseStopRequestExitCode(),
  };

  _cleanupListenerResources();

  console.log(`[stop-listener] Stop requested. source=${source} | reason=${reason}`);

  for (const callback of Array.from(_stopCallbacks)) {
    try {
      callback(getStopState());
    } catch (err) {
      console.error(`[stop-listener] stop callback error: ${err && err.message ? err.message : String(err)}`);
    }
  }

  if (options.fireRemoteCancel !== false) {
    _fireRemoteCancelRequests();
  }

  return true;
}

function executeStopSequence(options = {}) {
  return requestStop(options);
}

function _cleanupListenerResources() {
  if (_reconnectTimer) {
    clearTimeout(_reconnectTimer);
    _reconnectTimer = null;
  }

  if (_pollTimer) {
    clearTimeout(_pollTimer);
    _pollTimer = null;
  }

  if (_heartbeatTimer) {
    clearTimeout(_heartbeatTimer);
    _heartbeatTimer = null;
  }

  if (_activeSseReq) {
    try {
      _activeSseReq.destroy();
    } catch {
      /* ignore */
    }
    _activeSseReq = null;
  }
}

function _claimOwnership(url, runnerId) {
  return new Promise((resolve) => {
    _requestText(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(runnerId),
      timeoutMs: 10_000,
    })
      .then((res) => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          console.log(`[stop-listener] Claimed ownership on Firebase (HTTP ${res.statusCode}).`);
          resolve(true);
          return;
        }

        console.warn(`[stop-listener] Firebase PUT returned HTTP ${res.statusCode}.`);
        resolve(false);
      })
      .catch((err) => {
        console.warn("[stop-listener] Firebase PUT error:", err.message);
        resolve(false);
      });
  });
}

function _connectSSE(url, runnerId) {
  if (isStopRequested()) return;

  let urlObj;
  try {
    urlObj = new URL(url);
  } catch (e) {
    console.error("[stop-listener] Invalid STOP_FIREBASE_URL:", e.message);
    return;
  }

  const transport = urlObj.protocol === "http:" ? require("http") : require("https");
  const reconnectDelay = Math.max(1000, parseInt(process.env.STOP_POLL_INTERVAL_MS ?? "5000", 10) || 5000);
  const heartbeatMs = Math.max(15000, parseInt(process.env.STOP_HEARTBEAT_MS ?? "45000", 10) || 45000);

  const options = {
    protocol: urlObj.protocol,
    hostname: urlObj.hostname,
    port: urlObj.port || undefined,
    path: urlObj.pathname + urlObj.search,
    method: "GET",
    headers: {
      Accept: "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Accept-Encoding": "identity",
    },
  };

  const scheduleReconnect = (reason) => {
    if (_heartbeatTimer) {
      clearTimeout(_heartbeatTimer);
      _heartbeatTimer = null;
    }

    if (isStopRequested() || _reconnectTimer) return;

    console.warn(`[stop-listener] SSE ${reason}, reconnecting in ${reconnectDelay / 1000} s…`);
    _reconnectTimer = setTimeout(() => {
      _reconnectTimer = null;
      _connectSSE(url, runnerId);
    }, reconnectDelay);
    _reconnectTimer.unref?.();
  };

  const resetHeartbeat = () => {
    if (_heartbeatTimer) clearTimeout(_heartbeatTimer);
    _heartbeatTimer = setTimeout(() => {
      console.warn(`[stop-listener] SSE heartbeat timeout (${heartbeatMs / 1000}s no data) — force reconnect.`);
      if (_activeSseReq) {
        try {
          _activeSseReq.destroy(new Error("SSE heartbeat timeout"));
        } catch {
          /* ignore */
        }
      }
    }, heartbeatMs);
    _heartbeatTimer.unref?.();
  };

  const req = transport.request(options, (res) => {
    if (res.statusCode && [301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
      if (_heartbeatTimer) {
        clearTimeout(_heartbeatTimer);
        _heartbeatTimer = null;
      }
      const redirected = new URL(res.headers.location, urlObj).toString();
      console.log(`[stop-listener] SSE redirected to: ${redirected}`);
      res.resume();
      _connectSSE(redirected, runnerId);
      return;
    }

    if (res.statusCode && res.statusCode >= 400) {
      if (_heartbeatTimer) {
        clearTimeout(_heartbeatTimer);
        _heartbeatTimer = null;
      }
      console.error(`[stop-listener] SSE endpoint returned HTTP ${res.statusCode}. Check STOP_FIREBASE_URL / auth secret. Retrying in 30 s…`);
      res.resume();
      if (!_reconnectTimer) {
        _reconnectTimer = setTimeout(() => {
          _reconnectTimer = null;
          _connectSSE(url, runnerId);
        }, 30_000);
        _reconnectTimer.unref?.();
      }
      return;
    }

    console.log(`[stop-listener] SSE connected (HTTP ${res.statusCode}). Heartbeat: ${heartbeatMs / 1000}s`);
    resetHeartbeat();

    let buffer = "";
    let lastEventType = "";

    res.on("data", (chunk) => {
      resetHeartbeat();
      if (isStopRequested()) return;

      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trimEnd();

        if (trimmed.startsWith("event:")) {
          lastEventType = trimmed.replace(/^event:\s*/, "").trim();
          continue;
        }

        if (!trimmed.startsWith("data:")) continue;

        if (lastEventType && lastEventType !== "put" && lastEventType !== "patch") {
          if (lastEventType !== "keep-alive") {
            console.log(`[stop-listener] SSE skipping event type: "${lastEventType}"`);
          }
          lastEventType = "";
          continue;
        }

        const eventType = lastEventType || "put";
        lastEventType = "";

        try {
          const raw = trimmed.replace(/^data:\s*/, "");
          if (raw === "" || raw === "null") continue;

          const payload = JSON.parse(raw);
          const effectiveValue = _applyFirebaseEvent(_cachedObservedValue, payload, eventType);
          _cachedObservedValue = effectiveValue;
          _observeRunnerIdValue({
            source: "sse",
            runnerId,
            observedValue: effectiveValue,
            meta: {
              eventType,
              path: payload && typeof payload === "object" ? payload.path : undefined,
            },
          });
        } catch (e) {
          console.warn(`[stop-listener] SSE parse error: ${e.message} | raw: ${trimmed.slice(0, 160)}`);
        }
      }
    });

    res.on("end", () => scheduleReconnect("connection ended"));
    res.on("close", () => scheduleReconnect("connection closed"));
    res.on("error", (err) => {
      if (isStopRequested()) return;
      console.warn(`[stop-listener] SSE response error: ${err.message}`);
      scheduleReconnect("response error");
    });
  });

  req.on("error", (err) => {
    if (_heartbeatTimer) {
      clearTimeout(_heartbeatTimer);
      _heartbeatTimer = null;
    }
    if (isStopRequested()) return;
    console.warn(`[stop-listener] SSE request error: ${err.message}`);
    scheduleReconnect("request error");
  });

  req.on("socket", (socket) => {
    socket.setKeepAlive(true, 15_000);
    socket.setTimeout(0);
  });

  req.end();
  _activeSseReq = req;
}

function _startPolling(url, runnerId) {
  const intervalMs = Math.max(
    1000,
    parseInt(process.env.STOP_VALUE_POLL_INTERVAL_MS ?? process.env.STOP_POLL_INTERVAL_MS ?? "5000", 10) || 5000,
  );

  const runPoll = async () => {
    if (isStopRequested()) return;

    try {
      const res = await _requestText(url, {
        method: "GET",
        headers: { Accept: "application/json" },
        timeoutMs: Math.min(intervalMs, 10_000),
      });

      if (res.statusCode >= 400) {
        console.warn(`[stop-listener] Poll GET returned HTTP ${res.statusCode}.`);
      } else {
        const rawBody = `${res.body || ""}`.trim();
        const value = rawBody === "" ? null : JSON.parse(rawBody);
        _observeRunnerIdValue({ source: "poll", runnerId, observedValue: value });
      }
    } catch (err) {
      console.warn(`[stop-listener] Poll error: ${err && err.message ? err.message : String(err)}`);
    } finally {
      if (!isStopRequested()) {
        _pollTimer = setTimeout(runPoll, intervalMs);
        _pollTimer.unref?.();
      }
    }
  };

  void runPoll();
}

function _observeRunnerIdValue({ source, runnerId, observedValue, meta = {} }) {
  const ownId = `${runnerId || ""}`.trim();
  const eventType = meta.eventType ? ` | event=${meta.eventType}` : "";
  const path = meta.path ? ` | path=${meta.path}` : "";
  const logKey = `${source}:${JSON.stringify(observedValue)}`;

  if (observedValue === undefined) return;

  if (observedValue === null || observedValue === "") {
    if (_lastObservedLogKey !== logKey) {
      console.log(`[stop-listener] ${source} observed empty owner${eventType}${path}. Waiting for a real owner value.`);
      _lastObservedLogKey = logKey;
    }
    return;
  }

  if (typeof observedValue === "object") {
    const serialized = JSON.stringify(observedValue);
    if (_lastObservedLogKey !== logKey) {
      console.warn(`[stop-listener] ${source} observed non-scalar owner value${eventType}${path}: ${serialized}`);
      _lastObservedLogKey = logKey;
    }
    return;
  }

  const normalizedObserved = `${observedValue}`;
  if (_lastObservedLogKey !== logKey || normalizedObserved !== ownId) {
    console.log(`[stop-listener] ${source} observed owner: ${JSON.stringify(normalizedObserved)}${eventType}${path}`);
    _lastObservedLogKey = logKey;
  }

  if (normalizedObserved === ownId) {
    return;
  }

  const stopClassification = _classifyObservedOwnerValue({ observedValue: normalizedObserved, ownId });

  requestStop({
    source,
    runnerId: ownId,
    observedValue: normalizedObserved,
    reason: stopClassification.reason,
    exitCode: parseStopRequestExitCode(),
    fireRemoteCancel: true,
  });
}

function _classifyObservedOwnerValue({ observedValue, ownId }) {
  const normalizedObserved = `${observedValue || ""}`;
  const normalizedOwnId = `${ownId || ""}`.trim();

  if (!normalizedOwnId) {
    return {
      reason: `Observed control value changed to ${JSON.stringify(normalizedObserved)} while STOP_RUNNER_ID is empty.`,
    };
  }

  if (normalizedObserved === `stop-${normalizedOwnId}` || normalizedObserved === `stop:${normalizedOwnId}`) {
    return {
      reason: `Explicit stop token ${JSON.stringify(normalizedObserved)} matched this runner (${JSON.stringify(normalizedOwnId)}).`,
    };
  }

  return {
    reason: `Ownership changed to ${JSON.stringify(normalizedObserved)} (expected ${JSON.stringify(normalizedOwnId)}).`,
  };
}

function _applyFirebaseEvent(currentValue, payload, eventType) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }

  if (!Object.prototype.hasOwnProperty.call(payload, "data")) {
    return payload;
  }

  const path = typeof payload.path === "string" ? payload.path : "/";
  const data = payload.data;

  if (path === "/" || path === "") {
    if (eventType === "patch" && _isPlainObject(currentValue) && _isPlainObject(data)) {
      return { ...currentValue, ...data };
    }
    return data;
  }

  const nextRoot = _isContainer(currentValue) ? _cloneJson(currentValue) : {};
  const segments = path
    .split("/")
    .filter(Boolean)
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));

  if (segments.length === 0) {
    return data;
  }

  let cursor = nextRoot;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const key = segments[i];
    if (!_isContainer(cursor[key])) cursor[key] = {};
    cursor = cursor[key];
  }

  const leafKey = segments[segments.length - 1];
  if (data === null) {
    delete cursor[leafKey];
    return nextRoot;
  }

  if (eventType === "patch" && _isPlainObject(cursor[leafKey]) && _isPlainObject(data)) {
    cursor[leafKey] = { ...cursor[leafKey], ...data };
  } else {
    cursor[leafKey] = data;
  }

  return nextRoot;
}

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

function _fireRemoteCancelRequests() {
  void _cancelGitHubRun();
  void _cancelAzureBuild();
}

async function _cancelGitHubRun() {
  const [owner, repo] = `${process.env.GITHUB_REPOSITORY || ""}`.split("/");
  const runId = `${process.env.GITHUB_RUN_ID || ""}`.trim();
  const token = `${process.env.GITHUB_TOKEN || ""}`.trim();

  if (!owner || !repo || !runId || !token) {
    console.warn("[stop-listener] GitHub remote cancel skipped: missing GITHUB_REPOSITORY, GITHUB_RUN_ID or GITHUB_TOKEN.");
    return false;
  }

  try {
    const res = await _requestText(`https://api.github.com/repos/${owner}/${repo}/actions/runs/${runId}/cancel`, {
      method: "POST",
      timeoutMs: 3_000,
      unrefSocket: true,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "dotenvrtdb-stop-listener",
      },
    });

    console.log(`[stop-listener] GitHub cancel request finished with HTTP ${res.statusCode}.`);
    return res.statusCode >= 200 && res.statusCode < 300;
  } catch (err) {
    console.warn(`[stop-listener] GitHub cancel failed: ${err.message}`);
    return false;
  }
}

async function _cancelAzureBuild() {
  const org = `${process.env.SYSTEM_TEAMFOUNDATIONCOLLECTIONURI || ""}`.trim();
  const project = `${process.env.SYSTEM_TEAMPROJECT || ""}`.trim();
  const buildId = `${process.env.BUILD_BUILDID || ""}`.trim();
  const token = `${process.env.SYSTEM_ACCESSTOKEN || ""}`.trim();

  if (!org || !project || !buildId || !token) {
    return false;
  }

  try {
    const basic = Buffer.from(`:${token}`).toString("base64");
    const res = await _requestText(`${org}${project}/_apis/build/builds/${buildId}?api-version=7.1`, {
      method: "PATCH",
      timeoutMs: 3_000,
      unrefSocket: true,
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ status: "cancelling" }),
    });

    console.log(`[stop-listener] Azure cancel request finished with HTTP ${res.statusCode}.`);
    return res.statusCode >= 200 && res.statusCode < 300;
  } catch (err) {
    console.warn(`[stop-listener] Azure cancel failed: ${err.message}`);
    return false;
  }
}

function _requestText(url, options = {}, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    let urlObj;
    try {
      urlObj = new URL(url);
    } catch (err) {
      reject(err);
      return;
    }

    const transport = urlObj.protocol === "http:" ? require("http") : require("https");
    const body = options.body;
    const headers = { ...(options.headers || {}) };

    if (body !== undefined && !Object.prototype.hasOwnProperty.call(headers, "Content-Length")) {
      headers["Content-Length"] = Buffer.byteLength(body);
    }

    const req = transport.request(
      {
        protocol: urlObj.protocol,
        hostname: urlObj.hostname,
        port: urlObj.port || undefined,
        path: urlObj.pathname + urlObj.search,
        method: options.method || "GET",
        headers,
      },
      (res) => {
        if (res.statusCode && [301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          if (redirectCount >= 5) {
            reject(new Error("Too many redirects"));
            return;
          }
          const redirected = new URL(res.headers.location, urlObj).toString();
          _requestText(redirected, options, redirectCount + 1).then(resolve).catch(reject);
          return;
        }

        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          text += chunk;
        });
        res.on("end", () => {
          resolve({ statusCode: res.statusCode || 0, headers: res.headers, body: text });
        });
      },
    );

    let timeoutHandle = null;
    const timeoutMs = Math.max(1000, Number(options.timeoutMs) || 5000);
    timeoutHandle = setTimeout(() => {
      req.destroy(new Error(`Request timeout after ${timeoutMs} ms`));
    }, timeoutMs);
    timeoutHandle.unref?.();

    req.on("socket", (socket) => {
      socket.setKeepAlive(true, 15_000);
      if (options.unrefSocket) {
        socket.unref?.();
      }
    });

    req.on("error", (err) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      reject(err);
    });

    req.on("close", () => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    });

    if (body !== undefined) req.write(body);
    req.end();
  });
}

function _cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function _isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function _isContainer(value) {
  return _isPlainObject(value) || Array.isArray(value);
}

module.exports = {
  executeStopSequence,
  getStopState,
  isStopRequested,
  onStopRequested,
  requestStop,
  setStopRunnerIdOnRealtime,
  startStopListener,
};
