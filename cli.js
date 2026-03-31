#!/usr/bin/env node

/**
 * Triển khai thêm chức năng:
 * - [x]: Bổ sung printHelp(),
 *       + tham số -eUrl=https://xxx.com Url của Realtime database google để lưu các key=value.
 *       + thêm tham số --push: lưu dữ liệu từ path .env lên url (điều kiện, phải có cấu hình -e <path>, và path có tồn tại )
 *       + thêm tham số --pull: lấy dữ liệu từ url, lưu về path .env (điều kiện, phải có cấu hình -e <path>, và path có tồn tại)
 * - [x]: Triển khai thêm rtdbUtils
 * - [x]: Triển khai thêm parseUrlToArgV
 * - [x]: Triển khai executePull và executePush
 */

const spawn = require("cross-spawn");
const path = require("path");
const fs = require("fs");

function formatErrorMessage(context = "unknown", err) {
  if (!err) return `[${context}] Unknown error`;
  const message = err && err.message ? err.message : String(err);
  const code = err && err.code ? ` | code=${err.code}` : "";
  const syscall = err && err.syscall ? ` | syscall=${err.syscall}` : "";
  const filePath = err && err.path ? ` | path=${err.path}` : "";
  const cause =
    err && err.cause
      ? ` | cause=${err.cause && err.cause.message ? err.cause.message : String(err.cause)}`
      : "";
  return `[${context}] ${message}${code}${syscall}${filePath}${cause}`;
}

function logSyncStatus(action = "sync", { status = "unknown", file = "-", varCount = 0, message = "" } = {}) {
  const normalizedStatus = `${status || "unknown"}`.toUpperCase();
  const safeAction = `${action || "sync"}`.toUpperCase();
  const detail = message ? ` | reason=${message}` : "";
  console.log(`[${safeAction}] status=${normalizedStatus} | file=${file || "-"} | vars=${Number.isFinite(varCount) ? varCount : 0}${detail}`);
}

function ensureParentDirExists(filePath = "") {
  const target = `${filePath || ""}`.trim();
  if (!target) return;
  const absPath = path.resolve(target);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
}

const rtdbUtils = (() => {
  let rtdbUrl = ``;

  const setUrl = (url = "") => (rtdbUrl = url);

  function parseEnvPlaceholder(value) {
    if (typeof value !== "string") return null;
    const s = value.trim();

    let m = s.match(/^%([A-Za-z_][A-Za-z0-9_]*)%$/); // CMD: %VAR%
    if (m) return m[1];

    m = s.match(/^\$env:([A-Za-z_][A-Za-z0-9_]*)$/i); // PS: $env:VAR
    if (m) return m[1];

    m = s.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/); // bash: ${VAR}
    if (m) return m[1];

    m = s.match(/^\$([A-Za-z_][A-Za-z0-9_]*)$/); // bash: $VAR
    if (m) return m[1];

    return null;
  }

  function resolveRtdbUrlFromObjVar(rtdbUrl, objVar) {
    const envName = parseEnvPlaceholder(rtdbUrl);
    if (!envName) return rtdbUrl;

    if (!objVar || typeof objVar !== "object" || Array.isArray(objVar)) return rtdbUrl;
    if (!Object.prototype.hasOwnProperty.call(objVar, envName)) return rtdbUrl;

    const resolved = objVar[envName];
    if (typeof resolved !== "string" || resolved.trim() === "") return rtdbUrl;

    return resolved.trim();
  }

  function parseFileValueDirective(value = "") {
    if (typeof value !== "string") return null;
    const v = value.trim();
    if (!v) return null;

    if (v.startsWith("file:raw:")) {
      const filePath = v.slice("file:raw:".length).trim();
      if (!filePath) return null;
      return { type: "raw", filePath };
    }
    if (v.startsWith("file:base64:")) {
      const filePath = v.slice("file:base64:".length).trim();
      if (!filePath) return null;
      return { type: "base64", filePath };
    }
    return null;
  }

  function resolveEnvFileDirectives(objVar = {}, options = {}) {
    const baseDir = options && options.baseDir ? options.baseDir : process.cwd();
    const next = { ...objVar };

    for (const [key, val] of Object.entries(objVar || {})) {
      const directive = parseFileValueDirective(val);
      if (!directive) continue;

      const fullPath = path.isAbsolute(directive.filePath) ? directive.filePath : path.resolve(baseDir, directive.filePath);
      if (!fs.existsSync(fullPath)) {
        throw new Error(`[directive] File not found for key "${key}": ${fullPath}`);
      }

      if (directive.type === "raw") {
        next[key] = fs.readFileSync(fullPath, "utf8");
        continue;
      }
      if (directive.type === "base64") {
        next[key] = fs.readFileSync(fullPath).toString("base64");
      }
    }

    return next;
  }

  // --- pushTo ---
  const pushTo = async (objVar = {}) => {
    try {
      const finalUrl = resolveRtdbUrlFromObjVar(rtdbUrl, objVar);

      if (!finalUrl) {
        console.error(`[rtdb] Missing url. Provide --eUrl=https://...`);
        return false;
      }
      if (!objVar || typeof objVar !== "object" || Array.isArray(objVar)) {
        console.error(`[rtdb] pushTo expects an object key=value`);
        return false;
      }

      const keys = Object.keys(objVar);
      if (keys.length === 0) return true;

      const res = await fetch(finalUrl, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(objVar),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        console.error(`[rtdb] PATCH failed: HTTP ${res.status} ${res.statusText}${text ? ` - ${text}` : ""}`);
        return false;
      }
      return true;
    } catch (err) {
      console.error(formatErrorMessage("rtdb PATCH error", err));
      return false;
    }
  };

  const envPathPushTo = async (envPath = "") => {
    // Xử lý, chuyển .env bằng path, thành objVar, rồi gọi hàm pushTo
    try {
      const p = `${envPath || ""}`.trim();
      if (!p) {
        console.error(`[rtdb] Missing -e <path> for --push`);
        return { ok: false, file: p || "-", varCount: 0 };
      }
      if (!fs.existsSync(p)) {
        console.error(`[rtdb] Env file not found: ${p}`);
        return { ok: false, file: p, varCount: 0 };
      }
      const content = fs.readFileSync(p, "utf8");
      const parsed = dotenv.parse(content); // {KEY:VAL}
      const resolvedVars = resolveEnvFileDirectives(parsed, { baseDir: path.dirname(path.resolve(p)) });
      const varCount = Object.keys(resolvedVars || {}).length;
      const ok = await pushTo(resolvedVars);
      return { ok, file: p, varCount, reason: ok ? "" : "RTDB PATCH failed" };
    } catch (err) {
      console.error(formatErrorMessage("rtdb envPathPushTo error", err));
      return { ok: false, file: `${envPath || "-"} `.trim(), varCount: 0, reason: err && err.message ? err.message : String(err) };
    }
  };

  const pullFrom = async () => {
    // Lấy dữ liệu từ rtdbUrl, trả về objVar
    try {
      if (!rtdbUrl) {
        console.error(`[rtdb] Missing url. Provide --eUrl=https://...`);
        return {}; //objVar;
      }
      const res = await fetch(rtdbUrl, { method: "GET" });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        console.error(`[rtdb] GET failed: HTTP ${res.status} ${res.statusText} ${text ? `- ${text}` : ""}`);
        return {};
      }
      const data = await res.json().catch(() => ({}));
      if (!data || typeof data !== "object" || Array.isArray(data)) return {};
      return data;
    } catch (err) {
      console.error(formatErrorMessage("rtdb GET error", err));
      return {};
    }
  };
  /**
   * Helpers
   */
  function ensureEnvPathProvidedAndExists() {
    // Điều kiện: phải có cấu hình -e <path>, và path có tồn tại
    let envPath = "";
    if (argv.e) {
      envPath = typeof argv.e === "string" ? argv.e : argv.e[0];
    }
    envPath = `${envPath || ""}`.trim();
    if (!envPath) {
      console.error(`Missing -e <path>. This is required for --push/--pull.`);
      return { ok: false, envPath: "" };
    }
    if (!fs.existsSync(envPath)) {
      console.error(`Env file does not exist: ${envPath}`);
      return { ok: false, envPath };
    }
    return { ok: true, envPath };
  }

  function serializeEnv(obj = {}) {
    // Serialize obj -> .env lines (simple)
    // - Primitive -> string
    // - Object/Array -> JSON.stringify
    const keys = Object.keys(obj || {}).sort();
    const lines = [];
    for (const k of keys) {
      const v = obj[k];
      let s;
      if (v == null) s = "";
      else if (typeof v === "string") s = v;
      else if (typeof v === "number" || typeof v === "boolean") s = String(v);
      else s = JSON.stringify(v);

      // If contains newline -> JSON stringify as safe string
      if (typeof s === "string" && /[\r\n]/.test(s)) {
        s = JSON.stringify(s);
      }
      lines.push(`${k}=${s}`);
    }
    return lines.join("\n") + (lines.length ? "\n" : "");
  }

  function readEnvVarFromPath(envPath = "", varName = "") {
    try {
      const p = `${envPath || ""}`.trim();
      const key = `${varName || ""}`.trim();

      if (!p) {
        console.error(`[env] Missing -e <path>.`);
        return { ok: false, value: "" };
      }
      if (!fs.existsSync(p)) {
        console.error(`[env] Env file not found: ${p}`);
        return { ok: false, value: "" };
      }
      if (!key) {
        console.error(`[env] Missing --var=<name>.`);
        return { ok: false, value: "" };
      }

      const content = fs.readFileSync(p, "utf8");
      const parsed = dotenv.parse(content);
      if (!Object.prototype.hasOwnProperty.call(parsed, key)) {
        console.error(`[env] Variable not found in env file: ${key}`);
        return { ok: false, value: "" };
      }
      return { ok: true, value: `${parsed[key] ?? ""}` };
    } catch (err) {
      console.error(formatErrorMessage("env readEnvVarFromPath error", err));
      return { ok: false, value: "" };
    }
  }

  function decodeBase64ToBuffer(text = "") {
    try {
      // Accept standard and URL-safe base64, and ignore whitespace/newlines.
      const raw = `${text || ""}`.replace(/\s+/g, "");
      if (!raw) return { ok: true, buffer: Buffer.alloc(0) };

      const normalized = raw.replace(/-/g, "+").replace(/_/g, "/");
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
        return { ok: false, buffer: Buffer.alloc(0) };
      }

      const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
      const buffer = Buffer.from(padded, "base64");

      // Strict check: ensure input is a valid base64 payload.
      const expect = padded.replace(/=+$/g, "");
      const actual = buffer.toString("base64").replace(/=+$/g, "");
      if (expect !== actual) {
        return { ok: false, buffer: Buffer.alloc(0) };
      }
      return { ok: true, buffer };
    } catch (err) {
      console.error(formatErrorMessage("env decodeBase64ToBuffer error", err));
      return { ok: false, buffer: Buffer.alloc(0) };
    }
  }

  // ✅ Backward-compat: support legacy -eUrl (old systems) by rewriting argv -> --eUrl
  function normalizeLegacyArgs(rawArgv) {
    const out = [];
    for (const a of rawArgv) {
      // case: -eUrl=https://...
      if (typeof a === "string" && a.startsWith("-eUrl=")) {
        out.push("--eUrl=" + a.slice("-eUrl=".length));
        continue;
      }
      // case: -eUrl  https://...
      if (a === "-eUrl") {
        out.push("--eUrl");
        continue;
      }
      out.push(a);
    }
    return out;
  }

  function getVietnamDateTime(format = "full") {
    const now = new Date();
    const vietnamTime = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Ho_Chi_Minh" }));

    // Lấy các thành phần ngày giờ
    const year = vietnamTime.getFullYear();
    const month = String(vietnamTime.getMonth() + 1).padStart(2, "0");
    const day = String(vietnamTime.getDate()).padStart(2, "0");
    const hours = String(vietnamTime.getHours()).padStart(2, "0");
    const minutes = String(vietnamTime.getMinutes()).padStart(2, "0");
    const seconds = String(vietnamTime.getSeconds()).padStart(2, "0");

    // Các định dạng có sẵn
    const formats = {
      full: `${day}/${month}/${year} ${hours}:${minutes}:${seconds}`,
      date: `${day}/${month}/${year}`,
      time: `${hours}:${minutes}:${seconds}`,
      datetime: `${day}/${month}/${year} ${hours}:${minutes}`,
      iso: `${year}-${month}-${day}T${hours}:${minutes}:${seconds}`,
      "iso-date": `${year}-${month}-${day}`,
      "iso-time": `${hours}:${minutes}:${seconds}`,
      short: `${day}/${month}/${year} ${hours}:${minutes}`,
      long: `Ngày ${day} tháng ${month} năm ${year}, ${hours}:${minutes}:${seconds}`,
      timestamp: vietnamTime.getTime(),
    };

    // Nếu format là custom pattern, xử lý thay thế
    if (!formats[format]) {
      return format
        .replace("YYYY", year)
        .replace("YY", String(year).slice(-2))
        .replace("MM", month)
        .replace("DD", day)
        .replace("HH", hours)
        .replace("mm", minutes)
        .replace("ss", seconds);
    }

    return formats[format].toString();
  }
  function getDefaultRtdbEnv() {
    return {
      DOTENVRTDB_NOW_YYYYDDMMHH: getVietnamDateTime("YYYYMMDDHH"),
    };
  }

  return {
    setUrl,
    pushTo,
    envPathPushTo,
    pullFrom,
    serializeEnv,
    readEnvVarFromPath,
    decodeBase64ToBuffer,
    parseFileValueDirective,
    resolveEnvFileDirectives,
    ensureEnvPathProvidedAndExists,
    normalizeLegacyArgs,
    getVietnamDateTime,
    getDefaultRtdbEnv,
  };
})();

const argv = require("minimist")(rtdbUtils.normalizeLegacyArgs(process.argv.slice(2)));
const dotenv = require("dotenv");
const dotenvExpand = require("dotenv-expand").expand;

function printHelp() {
  console.log(
    [
      "Usage: dotenvrtdb [--help] [--debug] [--quiet=false] [-e <path>] [--eUrl=https://xxx] [--push|--pull] [-v <name>=<value>] [-p <variable name>] [-c [environment]] [--no-expand] [--shell[=<shell>]] [-- command]",
      "  --help              print help",
      "  --debug             output the files that would be processed but don't actually parse them or run the `command`",
      "  --quiet, -q         suppress debug output from dotenv (default: true)",
      "  -e <path>           parses the file <path> as a `.env` file and adds the variables to the environment",
      "  -e <path>           multiple -e flags are allowed",
      "  --eUrl=<url>        Google Firebase Realtime Database URL (REST). Used to pull/push key=value variables (auto append .json if missing)",
      "  --push              push variables from -e <path> .env file up to --eUrl (requires -e exists, and file exists)",
      "  --pull              pull variables from --eUrl and write back to -e <path> .env file (requires -e exists, and file exists)",
      "  --shell[=<shell>]   run the `command` through a shell (cross-env-shell style).",
      "                      tip: pass the whole command as ONE quoted string after `--` to preserve quoting/operators.",
      '                      example (cmd.exe): dotenvrtdb -e .env --shell -- "echo %API_BASE% && node app.js"',
      "                      example (bash):    dotenvrtdb -e .env --shell -- 'echo \"$API_BASE\" && node app.js'",
      '                      also supports inline env: dotenvrtdb --shell -- FOO=bar "echo %FOO%"',
      "  --writefileraw=<path>    write raw value from --var=<name> in -e <path> env file to <path>",
      "  --writefilebase64=<path> read --var=<name> from -e <path>, decode base64, then write binary to <path>",
      "  --var=<name>             env variable name used by --writefileraw/--writefilebase64 (repeatable, mapped by order)",
      "  --varraw=<name>          optional explicit variable for --writefileraw (repeatable, one-to-one with --writefileraw)",
      "  --varbase64=<name>       optional explicit variable for --writefilebase64 (repeatable, one-to-one with --writefilebase64)",
      "  -v <name>=<value>   put variable <name> into environment using value <value>",
      "  -v <name>=<value>   multiple -v flags are allowed",
      "  -p <variable>       print value of <variable> to the console. If you specify this, you do not have to specify a `command`",
      "  -c [environment]    support cascading env variables from `.env`, `.env.<environment>`, `.env.local`, `.env.<environment>.local` files",
      "  --no-expand         skip variable expansion",
      "  -o, --override      override system variables. Cannot be used along with cascade (-c).",
      "  command             `command` is the actual command you want to run. Best practice is to precede this command with ` -- `. Everything after `--` is considered to be your command. So any flags will not be parsed by this tool but be passed to your command. If you do not do it, this tool will strip those flags",
    ].join("\n"),
  );
}

function validateCmdVariable(param) {
  const [, key, val] = param.match(/^(\w+)=([\s\S]+)$/m) || [];
  if (!key || !val) {
    console.error(`Invalid variable name. Expected variable in format '-v variable=value', but got: \`-v ${param}\`.`);
    process.exit(1);
  }
  return [key, val];
}

async function main() {
  try {
    if (argv.help) {
      printHelp();
      process.exit();
    }

    const override = argv.o || argv.override;

    // Handle quiet flag - default is true (quiet), can be disabled with --quiet=false or -q=false
    const isQuiet = !(argv.quiet === false || argv.q === false || argv.quiet === "false" || argv.q === "false");

    if (argv.c && override) {
      console.error("Invalid arguments. Cascading env variables conflicts with overrides.");
      process.exit(1);
    }

    // Setup RTDB URL if provided
    if (argv.eUrl) {
      rtdbUtils.setUrl(argv.eUrl);
    }

  const executePush = async () => {
    /**
     * Nếu tồn tại argv.push, và có url thì thực hiện và trả về true, ngược lại false
     */
    if (!argv.push) return false;
    if (!argv.eUrl) {
      console.error(`Missing --eUrl=<url>. This is required for --push.`);
      logSyncStatus("push", { status: "failed", file: "-", varCount: 0, message: "missing --eUrl" });
      return true; // đã "xử lý" case push nhưng lỗi => vẫn kết thúc luồng
    }
    const { ok, envPath } = rtdbUtils.ensureEnvPathProvidedAndExists();
    if (!ok) {
      logSyncStatus("push", { status: "failed", file: envPath || "-", varCount: 0, message: "missing/invalid -e path" });
      return true;
    }

    const pushResult = await rtdbUtils.envPathPushTo(envPath);
    if (!pushResult.ok) {
      logSyncStatus("push", {
        status: "failed",
        file: pushResult.file || envPath,
        varCount: pushResult.varCount || 0,
        message: pushResult.reason || "unable to push env vars to RTDB",
      });
      process.exit(1);
    }
    logSyncStatus("push", { status: "success", file: pushResult.file || envPath, varCount: pushResult.varCount || 0 });
    return true;
  };

  const executePull = async () => {
    /**
     * Nếu tồn tại argv.pull, và có url thì thực hiện và trả về true, ngược lại false
     */
    if (!argv.pull) return false;
    if (!argv.eUrl) {
      console.error(`Missing --eUrl=<url>. This is required for --pull.`);
      logSyncStatus("pull", { status: "failed", file: "-", varCount: 0, message: "missing --eUrl" });
      return true; // đã "xử lý" case pull nhưng lỗi => vẫn kết thúc luồng
    }
    let envPath = "";
    if (argv.e) {
      envPath = typeof argv.e === "string" ? argv.e : argv.e[0];
    }
    envPath = `${envPath || ""}`.trim();
    if (!envPath) {
      logSyncStatus("pull", { status: "failed", file: "-", varCount: 0, message: "missing -e <path>" });
      return true;
    }
    if (!fs.existsSync(envPath)) {
      try {
        const absPath = path.resolve(envPath);
        fs.mkdirSync(path.dirname(absPath), { recursive: true });
        fs.writeFileSync(absPath, "", "utf8");
      } catch (err) {
        logSyncStatus("pull", {
          status: "failed",
          file: envPath,
          varCount: 0,
          message: formatErrorMessage("pull create env file failed", err),
        });
        process.exit(1);
      }
    }

    const objVar = {
      ...rtdbUtils.getDefaultRtdbEnv(),
      ...(await rtdbUtils.pullFrom()),
    };
    const pullVarCount = Object.keys(objVar || {}).length;

    try {
      const out = rtdbUtils.serializeEnv(objVar);
      fs.writeFileSync(envPath, out, "utf8");
      logSyncStatus("pull", { status: "success", file: envPath, varCount: pullVarCount });
    } catch (err) {
      console.error(`[pull] write error: ${err && err.message ? err.message : err}`);
      logSyncStatus("pull", { status: "failed", file: envPath, varCount: pullVarCount, message: "write file failed" });
      process.exit(1);
    }
    return true;
  };

  const executeWriteFileRaw = async () => {
    /**
     * Nếu tồn tại argv.writefileraw thì đọc --var từ -e <path> và ghi thẳng ra file.
     */
    if (!argv.writefileraw) return false;

    const outPaths = (Array.isArray(argv.writefileraw) ? argv.writefileraw : [argv.writefileraw])
      .map((v) => (typeof v === "string" ? v.trim() : ""))
      .filter(Boolean);
    if (outPaths.length === 0) {
      console.error(`Missing --writefileraw=<path>.`);
      return true;
    }

    const explicitRawVars = (Array.isArray(argv.varraw || argv.varRaw) ? argv.varraw || argv.varRaw : [argv.varraw || argv.varRaw])
      .map((v) => (typeof v === "string" ? v.trim() : ""))
      .filter(Boolean);

    const varNames = [];
    if (explicitRawVars.length > 0) {
      if (explicitRawVars.length !== outPaths.length) {
        console.error(`--varraw must have the same number of entries as --writefileraw.`);
        return true;
      }
      varNames.push(...explicitRawVars);
    } else {
      for (let i = 0; i < outPaths.length; i++) {
        const v = varPool[varCursor++] || "";
        varNames.push(v.trim());
      }
    }

    if (varNames.some((v) => !v)) {
      console.error(`Missing --var=<name>. This is required for --writefileraw (one var per output path).`);
      return true;
    }

    const { ok, envPath } = rtdbUtils.ensureEnvPathProvidedAndExists();
    if (!ok) return true;

    for (let i = 0; i < outPaths.length; i++) {
      const outPath = outPaths[i];
      const varName = varNames[i];

      const envVar = rtdbUtils.readEnvVarFromPath(envPath, varName);
      if (!envVar.ok) process.exit(1);

      try {
        ensureParentDirExists(outPath);
        fs.writeFileSync(outPath, envVar.value, "utf8");
      } catch (err) {
        console.error(`[writefileraw] write error: ${err && err.message ? err.message : err}`);
        process.exit(1);
      }
    }
    return true;
  };

  const executeWriteFileBase64 = async () => {
    /**
     * Nếu tồn tại argv.writefilebase64 thì đọc --var từ -e <path>, decode base64 và ghi ra file.
     */
    if (!argv.writefilebase64) return false;

    const outPaths = (Array.isArray(argv.writefilebase64) ? argv.writefilebase64 : [argv.writefilebase64])
      .map((v) => (typeof v === "string" ? v.trim() : ""))
      .filter(Boolean);
    if (outPaths.length === 0) {
      console.error(`Missing --writefilebase64=<path>.`);
      return true;
    }

    const explicitB64Vars = (Array.isArray(argv.varbase64 || argv.varBase64) ? argv.varbase64 || argv.varBase64 : [argv.varbase64 || argv.varBase64])
      .map((v) => (typeof v === "string" ? v.trim() : ""))
      .filter(Boolean);

    const varNames = [];
    if (explicitB64Vars.length > 0) {
      if (explicitB64Vars.length !== outPaths.length) {
        console.error(`--varbase64 must have the same number of entries as --writefilebase64.`);
        return true;
      }
      varNames.push(...explicitB64Vars);
    } else {
      for (let i = 0; i < outPaths.length; i++) {
        const v = varPool[varCursor++] || "";
        varNames.push(v.trim());
      }
    }

    if (varNames.some((v) => !v)) {
      console.error(`Missing --var=<name>. This is required for --writefilebase64 (one var per output path).`);
      return true;
    }

    const { ok, envPath } = rtdbUtils.ensureEnvPathProvidedAndExists();
    if (!ok) return true;

    for (let i = 0; i < outPaths.length; i++) {
      const outPath = outPaths[i];
      const varName = varNames[i];

      const envVar = rtdbUtils.readEnvVarFromPath(envPath, varName);
      if (!envVar.ok) process.exit(1);

      const decoded = rtdbUtils.decodeBase64ToBuffer(envVar.value);
      if (!decoded.ok) {
        console.error(`[writefilebase64] Invalid base64 content in variable: ${varName}`);
        process.exit(1);
      }

      try {
        ensureParentDirExists(outPath);
        fs.writeFileSync(outPath, decoded.buffer);
      } catch (err) {
        console.error(`[writefilebase64] write error: ${err && err.message ? err.message : err}`);
        process.exit(1);
      }
    }
    return true;
  };

    const varPool = (Array.isArray(argv.var) ? argv.var : [argv.var])
      .map((v) => (typeof v === "string" ? v.trim() : ""))
      .filter(Boolean);
    let varCursor = 0;

    const didPush = await executePush();
    if (didPush === true) {
      // push là mode riêng
      process.exit(0);
    }

    const didPull = await executePull();
    const didWriteFileRaw = await executeWriteFileRaw();
    const didWriteFileBase64 = await executeWriteFileBase64();
    if (didPull === true || didWriteFileRaw === true || didWriteFileBase64 === true) {
      // pull/writefile là mode riêng; cho phép kết hợp pull + writefile trong cùng một lệnh.
      process.exit(0);
    }

    let paths = [];
    if (argv.e) {
      if (typeof argv.e === "string") {
        paths.push(argv.e);
      } else {
        paths.push(...argv.e);
      }
    } else {
      paths.push(".env");
    }

    if (argv.c) {
      paths = paths.reduce(
        (accumulator, p) =>
          accumulator.concat(typeof argv.c === "string" ? [`${p}.${argv.c}.local`, `${p}.local`, `${p}.${argv.c}`, p] : [`${p}.local`, p]),
        [],
      );
    }

    const variables = [];
    if (argv.v) {
      if (typeof argv.v === "string") {
        variables.push(validateCmdVariable(argv.v));
      } else {
        variables.push(...argv.v.map(validateCmdVariable));
      }
    }

  const parseUrlToArgV = async () => {
    /**
     * Dùng rtdbUtils để đưa các var từ --eUrl vào variables.
     *    - Phải kiểm tra nếu có truyền --eUrl vào thì mới thực hiện tiếp chỗ này, không có thì không thực thi, kiểm tra bằng cách
     * có giá trị argv.eUrl thì truyền giá trị url này vào  rtdbUtils bằng hàm set để xử lý.
     *    - Nếu có các key, value từ url, thì đưa vào variables
     */
    if (!argv.eUrl) return;
    // url đã được set phía trên, nhưng vẫn giữ đúng tinh thần comment
    rtdbUtils.setUrl(argv.eUrl);

    const objVar = await rtdbUtils.pullFrom();
    if (!objVar || typeof objVar !== "object") return;

    for (const [k, v] of Object.entries(objVar)) {
      if (!k) continue;
      let val;
      if (v == null) val = "";
      else if (typeof v === "string") val = v;
      else if (typeof v === "number" || typeof v === "boolean") val = String(v);
      else val = JSON.stringify(v);

      variables.push([k, val]);
    }
  };

    await parseUrlToArgV();

  // Merge default env với variables (variables sẽ override default)
    const defaultEnv = rtdbUtils.getDefaultRtdbEnv() || {};
    const parsedVariables = {
      ...defaultEnv,
      ...Object.fromEntries(variables),
    };

    if (argv.debug) {
      console.log(paths);
      console.log(parsedVariables);
      process.exit();
    }

    paths.forEach(function (env) {
      try {
        dotenv.config({ path: path.resolve(env), override, quiet: isQuiet });
      } catch (err) {
        console.error(formatErrorMessage(`dotenv config failed for ${env}`, err));
        process.exit(1);
      }
    });

  // Expand when all path configs are loaded
    if (argv.expand !== false) {
      try {
        dotenvExpand({
          parsed: process.env,
        });
      } catch (err) {
        console.error(formatErrorMessage("dotenv expand failed", err));
        process.exit(1);
      }
    }

    Object.assign(process.env, parsedVariables);

    if (argv.p) {
      let value = process.env[argv.p];
      if (typeof value === "string") {
        value = `${value}`;
      }
      console.log(value != null ? value : "");
      process.exit();
    }

  // cross-env-shell style: allow `KEY=VALUE` at the beginning of the command section (after `--`)
  function parseLeadingEnvAssignments(args = []) {
    const env = {};
    let i = 0;
    for (; i < args.length; i++) {
      const a = args[i];
      if (typeof a !== "string") break;
      const eq = a.indexOf("=");
      if (eq <= 0) break;
      const key = a.slice(0, eq);
      const val = a.slice(eq + 1);
      // Keep it strict-ish to avoid eating normal args like --foo=bar
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) break;
      env[key] = val;
    }
    return { env, rest: args.slice(i) };
  }

    const shellOptRaw = argv.shell;
    let shellOpt = shellOptRaw;
    if (typeof shellOptRaw === "string") {
      const t = shellOptRaw.trim().toLowerCase();
      if (t === "true" || t === "1" || t === "yes") shellOpt = true;
      else if (t === "false" || t === "0" || t === "no") shellOpt = false;
      else shellOpt = shellOptRaw.trim();
    }

    const runInShell = shellOpt === true || (typeof shellOpt === "string" && shellOpt !== "");
    const { env: inlineEnv, rest: cmdArgs } = runInShell ? parseLeadingEnvAssignments(argv._) : { env: {}, rest: argv._ };

    if (cmdArgs.length === 0) {
      printHelp();
      process.exit(1);
    }

    const childEnv = Object.keys(inlineEnv).length ? Object.assign({}, process.env, inlineEnv) : process.env;

    const spawnOpts = {
      stdio: "inherit",
      env: childEnv,
    };

  // If --shell is provided:
  // - boolean true => use platform default shell
  // - string => pass through to node spawn `shell` option (advanced)
    let child;
    if (runInShell) {
      const shellCommand = cmdArgs.length === 1 ? cmdArgs[0] : cmdArgs.join(" ");
      const shellVal = typeof shellOpt === "string" ? shellOpt : true;
      child = spawn(shellCommand, [], Object.assign({}, spawnOpts, { shell: shellVal }));
    } else {
      const command = cmdArgs[0];
      child = spawn(command, cmdArgs.slice(1), spawnOpts);
    }

    child.on("error", function (err) {
      console.error(formatErrorMessage("spawn process error", err));
      process.exit(1);
    });

    child.on("exit", function (exitCode, signal) {
      if (typeof exitCode === "number") {
        process.exit(exitCode);
      } else {
        process.kill(process.pid, signal);
      }
    });

    for (const signal of ["SIGINT", "SIGTERM", "SIGPIPE", "SIGHUP", "SIGBREAK", "SIGWINCH", "SIGUSR1", "SIGUSR2"]) {
      process.on(signal, function () {
        child.kill(signal);
      });
    }
  } catch (err) {
    console.error(formatErrorMessage("main error", err));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(formatErrorMessage("fatal error", err));
  process.exit(1);
});
