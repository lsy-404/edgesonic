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

// Pure helpers for the account-activation feature: response parsing, display
// state derivation, backend error → i18n key mapping, and datetime-local
// conversions. Kept DOM-free so they run under plain tsx in test/frontend.

export type ActivationStatus = "permanent" | "active_until" | "disabled";

export interface ActivationInfo {
  /** Server-wide switch. false → everyone is treated as permanently active. */
  enabled: boolean;
  status: ActivationStatus;
  /** Unix seconds; only meaningful when status === "active_until". */
  until: number | null;
  active: boolean;
}

/** Shape used before the backend ships the feature: everything is active. */
export const DEFAULT_ACTIVATION: ActivationInfo = {
  enabled: false, status: "permanent", until: null, active: true,
};

function asStatus(v: unknown): ActivationStatus {
  return v === "active_until" || v === "disabled" ? v : "permanent";
}

/**
 * Defensive parse of the `{enabled, status, until, active}` shape carried by
 * /auth/me's `activation` field and GET /edgesonic/activation/me. Anything
 * malformed degrades to DEFAULT_ACTIVATION so an old backend never locks the
 * UI.
 */
export function parseActivation(raw: unknown): ActivationInfo {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_ACTIVATION };
  const o = raw as Record<string, unknown>;
  const until = typeof o.until === "number" && Number.isFinite(o.until) ? o.until : null;
  return {
    enabled: o.enabled === true,
    status: asStatus(o.status),
    until,
    // Missing `active` on a well-formed object is treated as active only when
    // the switch is off; an enabled backend always sends the flag.
    active: typeof o.active === "boolean" ? o.active : o.enabled !== true,
  };
}

export type ActivationDisplay = "permanent" | "until" | "expired" | "disabled";

/** Three-state (plus expired) presentation of a user's activation. */
export function activationDisplay(
  status: ActivationStatus,
  until: number | null,
  nowSec: number = Math.floor(Date.now() / 1000),
): ActivationDisplay {
  if (status === "disabled") return "disabled";
  if (status === "active_until") return until !== null && until > nowSec ? "until" : "expired";
  return "permanent";
}

/**
 * Map a backend error sentence (short English) to an i18n key under
 * `activation.errors.*`. Returns null when the message is not
 * activation-shaped so callers can fall back to showing the raw text.
 */
export function mapActivationError(error: string): string | null {
  const e = error.toLowerCase();
  if (e.includes("invite") || e.includes("activation code") || e.includes("code")) {
    if (e.includes("required") || e.includes("missing")) return "activation.errors.inviteRequired";
    if (e.includes("revoked")) return "activation.errors.inviteRevoked";
    if (e.includes("exhausted") || e.includes("uses") || e.includes("used up")) return "activation.errors.inviteExhausted";
    if (e.includes("expired")) return "activation.errors.inviteExpired";
    if (e.includes("invalid") || e.includes("not found") || e.includes("unknown")) return "activation.errors.inviteInvalid";
    if (e.includes("invite")) return "activation.errors.inviteInvalid";
    return null;
  }
  if (e.includes("email") && e.includes("verif")) return "activation.errors.emailVerificationRequired";
  if (e.includes("already") && (e.includes("permanent") || e.includes("active"))) return "activation.errors.alreadyPermanent";
  return null;
}

export type GateHint = "invite" | "email" | "allOf" | "anyOf" | null;

/**
 * Which registration-requirement hint to show, given the gate mode and the
 * enabled "creation option" set (email verification / invite code).
 */
export function registerGateHint(
  mode: "all" | "any",
  emailVerification: boolean,
  inviteCode: boolean,
): GateHint {
  if (emailVerification && inviteCode) return mode === "any" ? "anyOf" : "allOf";
  if (inviteCode) return "invite";
  if (emailVerification) return "email";
  return null;
}

/** Unix seconds → value for an <input type="datetime-local"> (local time). */
export function toDatetimeLocal(sec: number | null): string {
  if (sec === null || !Number.isFinite(sec) || sec <= 0) return "";
  const d = new Date(sec * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** datetime-local value (interpreted as local time) → unix seconds, or null. */
export function fromDatetimeLocal(value: string): number | null {
  if (!value) return null;
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? Math.floor(ts / 1000) : null;
}
