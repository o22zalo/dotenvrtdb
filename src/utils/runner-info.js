// Path: src/utils/runner-info.js
"use strict";

/**
 * runner-info.js
 *
 * Thu thập thông tin môi trường runner (GitHub Actions, Azure Pipelines, self-hosted)
 * và trả về object với prefix _DOTENVRTDB_RUNNER_.
 *
 * Cách dùng:
 *   const { collectRunnerInfo } = require("./src/utils/runner-info");
 *   const runnerInfo = collectRunnerInfo();
 *   // => { _DOTENVRTDB_RUNNER_HOST_TYPE: "github", _DOTENVRTDB_RUNNER_REPO: "...", ... }
 */

const os = require("os");

const PREFIX = "_DOTENVRTDB_RUNNER_";

/**
 * Detect host type từ environment variables.
 * @returns {"github"|"azure"|"selfhost"}
 */
function detectHostType() {
  if (process.env.GITHUB_ACTIONS === "true") return "github";
  // Azure Pipelines set TF_BUILD=True
  if (process.env.TF_BUILD === "True") return "azure";
  return "selfhost";
}

/**
 * Thu thập thông tin từ GitHub Actions environment.
 */
function collectGitHubInfo() {
  const fullRepo = process.env.GITHUB_REPOSITORY || ""; // "owner/repo"
  const slashIdx = fullRepo.indexOf("/");
  const org = slashIdx >= 0 ? fullRepo.slice(0, slashIdx) : "";
  const repo = slashIdx >= 0 ? fullRepo.slice(slashIdx + 1) : fullRepo;

  return {
    [`${PREFIX}HOST_TYPE`]: "github",
    [`${PREFIX}REPO`]: repo,
    [`${PREFIX}ORG`]: org,
    [`${PREFIX}RUN_ID`]: process.env.GITHUB_RUN_ID || "",
    [`${PREFIX}RUN_ATTEMPT`]: process.env.GITHUB_RUN_ATTEMPT || "",
    [`${PREFIX}JOB`]: process.env.GITHUB_JOB || "",
    [`${PREFIX}WORKFLOW`]: process.env.GITHUB_WORKFLOW || "",
    [`${PREFIX}PIPELINE`]: process.env.GITHUB_WORKFLOW || "",
    [`${PREFIX}WORKFLOW_FILE`]: process.env.GITHUB_WORKFLOW_REF || "",
    [`${PREFIX}OS`]: process.env.RUNNER_OS || os.platform(),
    [`${PREFIX}ARCH`]: process.env.RUNNER_ARCH || os.arch(),
    [`${PREFIX}HOSTNAME`]: process.env.RUNNER_NAME || os.hostname(),
    [`${PREFIX}ACTOR`]: process.env.GITHUB_ACTOR || "",
    [`${PREFIX}BRANCH`]: process.env.GITHUB_REF_NAME || process.env.GITHUB_REF || "",
    [`${PREFIX}EVENT`]: process.env.GITHUB_EVENT_NAME || "",
    [`${PREFIX}SHA`]: process.env.GITHUB_SHA || "",
    [`${PREFIX}SERVER_URL`]: process.env.GITHUB_SERVER_URL || "",
  };
}

/**
 * Thu thập thông tin từ Azure Pipelines environment.
 */
function collectAzureInfo() {
  return {
    [`${PREFIX}HOST_TYPE`]: "azure",
    [`${PREFIX}REPO`]: process.env.BUILD_REPOSITORY_NAME || "",
    [`${PREFIX}ORG`]: process.env.SYSTEM_TEAMPROJECT || "",
    [`${PREFIX}RUN_ID`]: process.env.BUILD_BUILDID || "",
    [`${PREFIX}RUN_ATTEMPT`]: process.env.SYSTEM_JOBATTEMPT || "",
    [`${PREFIX}JOB`]: process.env.SYSTEM_JOBDISPLAYNAME || "",
    [`${PREFIX}WORKFLOW`]: process.env.BUILD_DEFINITIONNAME || "",
    [`${PREFIX}PIPELINE`]: process.env.BUILD_DEFINITIONNAME || "",
    [`${PREFIX}WORKFLOW_FILE`]: process.env.BUILD_DEFINITIONNAME || "",
    [`${PREFIX}OS`]: process.env.AGENT_OS || os.platform(),
    [`${PREFIX}ARCH`]: os.arch(),
    [`${PREFIX}HOSTNAME`]: process.env.AGENT_MACHINENAME || process.env.AGENT_NAME || os.hostname(),
    [`${PREFIX}ACTOR`]: process.env.BUILD_REQUESTEDFOR || "",
    [`${PREFIX}BRANCH`]: process.env.BUILD_SOURCEBRANCHNAME || "",
    [`${PREFIX}EVENT`]: "",
    [`${PREFIX}SHA`]: process.env.BUILD_SOURCEVERSION || "",
    [`${PREFIX}SERVER_URL`]: process.env.SYSTEM_TEAMFOUNDATIONCOLLECTIONURI || "",
  };
}

/**
 * Thu thập thông tin cho môi trường self-hosted / generic.
 */
function collectSelfHostInfo() {
  return {
    [`${PREFIX}HOST_TYPE`]: "selfhost",
    [`${PREFIX}REPO`]: "",
    [`${PREFIX}ORG`]: "",
    [`${PREFIX}RUN_ID`]: "",
    [`${PREFIX}RUN_ATTEMPT`]: "",
    [`${PREFIX}JOB`]: "",
    [`${PREFIX}WORKFLOW`]: "",
    [`${PREFIX}PIPELINE`]: "",
    [`${PREFIX}WORKFLOW_FILE`]: "",
    [`${PREFIX}OS`]: os.platform(),
    [`${PREFIX}ARCH`]: os.arch(),
    [`${PREFIX}HOSTNAME`]: os.hostname(),
    [`${PREFIX}ACTOR`]: process.env.USER || process.env.USERNAME || "",
    [`${PREFIX}BRANCH`]: "",
    [`${PREFIX}EVENT`]: "",
    [`${PREFIX}SHA`]: "",
    [`${PREFIX}SERVER_URL`]: "",
  };
}

/**
 * Thu thập toàn bộ thông tin runner, bỏ qua các key có value rỗng.
 *
 * Priority: remote pulled data có thể override runner info nếu cần,
 * nhưng trong executePull runner info được merge LAST để đảm bảo
 * các giá trị factual (hostname, os, run_id) không bị remote ghi đè.
 *
 * @returns {Record<string, string>}
 */
function collectRunnerInfo() {
  const hostType = detectHostType();

  let raw;
  if (hostType === "github") raw = collectGitHubInfo();
  else if (hostType === "azure") raw = collectAzureInfo();
  else raw = collectSelfHostInfo();

  // Chỉ giữ lại key có giá trị, stringify an toàn
  const result = {};
  for (const [k, v] of Object.entries(raw)) {
    const str = `${v ?? ""}`.trim();
    if (str) result[k] = str;
  }

  return result;
}

module.exports = { collectRunnerInfo, detectHostType };
