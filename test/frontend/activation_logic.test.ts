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

// Run: npx tsx test/frontend/activation_logic.test.ts

import {
  parseActivation, activationDisplay, mapActivationError,
  registerGateHint, toDatetimeLocal, fromDatetimeLocal,
} from "../../web/src/lib/activation";

let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

console.log("parseActivation:");
{
  const d = parseActivation(undefined);
  assert(!d.enabled && d.active && d.status === "permanent", "missing payload degrades to active/permanent");
  const on = parseActivation({ enabled: true, status: "active_until", until: 1234, active: true });
  assert(on.enabled && on.status === "active_until" && on.until === 1234 && on.active, "well-formed payload passes through");
  const bad = parseActivation({ enabled: true, status: "weird", until: "soon", active: false });
  assert(bad.status === "permanent" && bad.until === null && !bad.active, "malformed fields fall back field-by-field");
  assert(parseActivation("nope").active, "non-object payload is treated as inactive switch");
}

console.log("activationDisplay:");
{
  const now = 1_000_000;
  assert(activationDisplay("permanent", null, now) === "permanent", "permanent stays permanent");
  assert(activationDisplay("disabled", null, now) === "disabled", "disabled wins over until");
  assert(activationDisplay("active_until", now + 10, now) === "until", "future until shows as until");
  assert(activationDisplay("active_until", now - 10, now) === "expired", "past until shows as expired");
  assert(activationDisplay("active_until", null, now) === "expired", "active_until without a date is expired");
}

console.log("mapActivationError:");
{
  const cases: Array<[string, string | null]> = [
    ["invite code required", "activation.errors.inviteRequired"],
    ["Invite code is missing", "activation.errors.inviteRequired"],
    ["invalid invite code", "activation.errors.inviteInvalid"],
    ["invite code not found", "activation.errors.inviteInvalid"],
    ["invite code revoked", "activation.errors.inviteRevoked"],
    ["invite code exhausted", "activation.errors.inviteExhausted"],
    ["invite code has no uses left", "activation.errors.inviteExhausted"],
    ["invite code expired", "activation.errors.inviteExpired"],
    ["email verification required", "activation.errors.emailVerificationRequired"],
    ["account already permanent", "activation.errors.alreadyPermanent"],
    ["username taken", null],
    ["internal error", null],
  ];
  for (const [input, expected] of cases) {
    assert(mapActivationError(input) === expected, `"${input}" → ${expected ?? "raw"}`);
  }
}

console.log("registerGateHint:");
{
  assert(registerGateHint("all", true, true) === "allOf", "all + both options → allOf");
  assert(registerGateHint("any", true, true) === "anyOf", "any + both options → anyOf");
  assert(registerGateHint("all", false, true) === "invite", "invite only");
  assert(registerGateHint("any", true, false) === "email", "email only");
  assert(registerGateHint("all", false, false) === null, "empty option set → no hint");
}

console.log("datetime-local round-trip:");
{
  assert(toDatetimeLocal(null) === "", "null → empty input value");
  assert(fromDatetimeLocal("") === null, "empty input → null");
  assert(fromDatetimeLocal("not-a-date") === null, "garbage input → null");
  const sec = fromDatetimeLocal("2030-05-06T07:08");
  assert(typeof sec === "number" && sec! > 0, "datetime-local parses to unix seconds");
  assert(toDatetimeLocal(sec) === "2030-05-06T07:08", "round-trips through local time");
}

if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log("all activation logic tests passed");
