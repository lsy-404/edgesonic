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

export const DEPLOY_STEPS = [
  "preflight",
  "d1",
  "r2",
  "schema",
  "download",
  "rebuild",
  "assets",
  "worker",
  "deploy",
  "secrets",
  "cron",
  "admin",
  "health",
] as const;

export type DeployStep = (typeof DEPLOY_STEPS)[number];

export class DeployError extends Error {
  constructor(public readonly step: DeployStep, message: string) {
    super(message);
    this.name = "DeployError";
  }
}

export interface DeployCredentials {
  accountId: string;
  apiToken: string;
  r2AccessKeyId: string;
  r2SecretAccessKey: string;
}

/**
 * What a deployment does about the Sandbox transcoding container:
 * "keep" mirrors whatever the live Worker declares, "deploy" declares it, and
 * "off" leaves it out. The image itself can only be published by wrangler from
 * a machine with Docker, so "deploy" needs one to already exist for the class.
 */
export type ContainerMode = "keep" | "deploy" | "off";

export interface DeployTarget {
  mode: "fresh" | "overwrite";
  workerName: string;
  dbName: string;
  bucketName: string;
  domain: string;
  releaseTag: string;
  resetAdmin: boolean;
  fullRebuild: boolean;
  containerMode: ContainerMode;
  adminUsername?: string;
  adminPassword?: string;
}

export interface DeployResult {
  accountId: string;
  url: string;
  adminUsername?: string;
  adminPassword?: string;
  version: string;
}

export type StepStatus = "pending" | "running" | "success" | "failed";

export interface StepState {
  step: DeployStep;
  status: StepStatus;
  detail?: string;
  /** 0–1, only set by steps that move a known number of bytes. */
  progress?: number;
}
