// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.

import { defineStore } from "pinia";
import { ref, watch } from "vue";
import type { GithubRelease, ReleaseOption } from "../../../shared/autoupdate";
import { GITHUB_REPO } from "../../../shared/autoupdate";
import { DEPLOY_STEPS, type DeployCredentials, type DeployResult, type DeployStep, type StepState, type StepStatus } from "../lib/deploy/types";

const CREDS_KEY = "edgesonic_installer_creds";

function emptyCredentials(): DeployCredentials {
  return { accountId: "", apiToken: "", r2AccessKeyId: "", r2SecretAccessKey: "" };
}

function loadCredentials(): DeployCredentials {
  try {
    const raw = sessionStorage.getItem(CREDS_KEY);
    if (!raw) return emptyCredentials();
    const parsed = JSON.parse(raw) as Partial<DeployCredentials>;
    return { ...emptyCredentials(), ...parsed };
  } catch {
    return emptyCredentials();
  }
}

export const useWizard = defineStore("wizard", () => {
  const step = ref(1);
  const mode = ref<"fresh" | "overwrite">("fresh");

  // Credentials — sessionStorage only, per this project's rule that the CF
  // token and R2 keys are never persisted past the browser tab. Cleared
  // outright on a finished deploy; on a failed one, only the sessionStorage
  // copy is wiped (closing/reloading the tab loses them) while the in-memory
  // value survives so an immediate retry in the same tab doesn't force
  // retyping everything.
  const credentials = ref<DeployCredentials>(loadCredentials());
  const credentialsVerified = ref(false);
  const accountName = ref("");
  const r2Enabled = ref<boolean | null>(null);

  watch(
    credentials,
    (value) => {
      try {
        sessionStorage.setItem(CREDS_KEY, JSON.stringify(value));
      } catch {
        // Storage full/unavailable (private browsing) — not fatal, the form still works in-memory.
      }
    },
    { deep: true },
  );

  function clearCredentials(wipeMemory: boolean) {
    sessionStorage.removeItem(CREDS_KEY);
    if (wipeMemory) credentials.value = emptyCredentials();
    credentialsVerified.value = false;
  }

  // Deployment target
  const workerName = ref("edgesonic");
  const dbName = ref("edgesonic-db");
  const bucketName = ref("edgesonic-music");
  const domain = ref("");
  const sourceRepo = ref(GITHUB_REPO);

  // Only follows workerName while the db/bucket fields still hold the
  // previous auto-derived default — once someone edits either by hand, this
  // stops clobbering their choice.
  watch(workerName, (value, oldValue) => {
    const trimmed = value.trim() || "edgesonic";
    const prevTrimmed = (oldValue || "").trim() || "edgesonic";
    if (dbName.value === `${prevTrimmed}-db`) dbName.value = `${trimmed}-db`;
    if (bucketName.value === `${prevTrimmed}-music`) bucketName.value = `${trimmed}-music`;
  });

  // Version selection
  const releases = ref<ReleaseOption[]>([]);
  const rawReleases = ref<GithubRelease[]>([]);
  const selectedTag = ref("");

  function selectedRelease(): GithubRelease | null {
    return rawReleases.value.find((r) => r.tag_name === selectedTag.value) || null;
  }

  // Execute step
  const stepStates = ref<StepState[]>(DEPLOY_STEPS.map((s) => ({ step: s, status: "pending" as StepStatus })));
  const result = ref<DeployResult | null>(null);
  const deployFailed = ref(false);

  function setStepStatus(deployStep: DeployStep, status: StepStatus, detail?: string) {
    const entry = stepStates.value.find((s) => s.step === deployStep);
    if (entry) {
      entry.status = status;
      entry.detail = detail;
    }
    if (status === "failed") deployFailed.value = true;
  }

  function resetExecution() {
    stepStates.value = DEPLOY_STEPS.map((s) => ({ step: s, status: "pending" as StepStatus }));
    result.value = null;
    deployFailed.value = false;
  }

  function finishSuccess(deployResult: DeployResult) {
    result.value = deployResult;
    clearCredentials(true);
  }

  function finishFailure() {
    clearCredentials(false);
  }

  function goTo(target: number) {
    step.value = target;
  }

  return {
    step,
    mode,
    credentials,
    credentialsVerified,
    accountName,
    r2Enabled,
    clearCredentials,
    workerName,
    dbName,
    bucketName,
    domain,
    sourceRepo,
    releases,
    rawReleases,
    selectedTag,
    selectedRelease,
    stepStates,
    result,
    deployFailed,
    setStepStatus,
    resetExecution,
    finishSuccess,
    finishFailure,
    goTo,
  };
});
