import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("client page keeps credential behavior and concise localized labels", async () => {
  const [view, en, zh] = await Promise.all([
    read("../../web/src/views/SubsonicClients.vue"),
    read("../../web/src/locales/en.json").then(JSON.parse),
    read("../../web/src/locales/zh-CN.json").then(JSON.parse),
  ]);

  for (const path of ["auth/credentials/list", "auth/credentials/create", "auth/credentials/update", "auth/credentials/delete"]) {
    assert.ok(view.includes(path), `missing credential endpoint ${path}`);
  }
  assert.match(view, /hasPerm\("manage_credentials"\)/);
  assert.match(view, /v-if="canManageCredentials"/);
  assert.match(view, /issued\.password/);
  assert.match(view, /copyText\(issued\.password\)/);
  assert.match(view, /<details class="clients-card recommended-clients card">/);
  assert.match(view, /https:\/\/music\.aqzscn\.cn\/docs\/intro\//);
  assert.match(view, /https:\/\/www\.symfonium\.app\//);
  assert.match(view, /https:\/\/ultrasonic\.gitlab\.io\//);
  assert.match(view, /https:\/\/github\.com\/supersonic-app\/supersonic/);

  assert.equal(en.app.menu.subsonicClients, "Clients");
  assert.equal(zh.app.menu.subsonicClients, "客户端");
  assert.equal(en.settings.clients.createPassword, "Create client password");
  assert.equal(zh.settings.clients.createPassword, "创建客户端密码");
  assert.equal(en.settings.clients.recommendedTitle, "Recommended clients");
  assert.equal(zh.settings.clients.recommendedTitle, "推荐客户端");
  assert.equal(en.settings.clients.createdTitle, "Copy this password now — it is shown once");
  assert.ok(!view.includes("永远无法访问文件与管理功能"));
});
