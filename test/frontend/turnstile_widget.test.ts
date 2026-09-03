import * as fs from "node:fs";
import * as path from "node:path";

const root = path.resolve(__dirname, "../..");
const helper = fs.readFileSync(path.join(root, "web/src/lib/turnstile.ts"), "utf8");
const login = fs.readFileSync(path.join(root, "web/src/views/Login.vue"), "utf8");
const register = fs.readFileSync(path.join(root, "web/src/views/Register.vue"), "utf8");

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
}

assert(helper.includes("api.js?render=explicit"), "loads the official API only through the explicit renderer");
assert(helper.includes("action,"), "passes the requested action to Turnstile");
assert(helper.includes('"expired-callback"'), "clears tokens when the widget expires");
assert(login.includes('renderTurnstile(turnstileContainer.value, turnstileSiteKey.value, "login"'), "Login renders the login action widget when configured");
assert(register.includes('renderTurnstile(turnstileContainer.value, turnstileSiteKey.value, "register"'), "Register renders the register action widget when configured");
assert(!login.includes("Verification token") && !register.includes("Verification token"), "manual token inputs are removed");
console.log("Turnstile widget wiring checks passed");
