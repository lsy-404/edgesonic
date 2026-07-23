
<script setup lang="ts">
// SPDX-License-Identifier: AGPL-3.0-or-later
import { onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import { useI18n } from "vue-i18n";
import { useAuth } from "../api";

const { t } = useI18n();
const { confirmEmailVerify, isLoggedIn } = useAuth();
const route = useRoute();

const state = ref<"checking" | "success" | "error">("checking");
const error = ref("");

onMounted(async () => {
  const token = typeof route.query.token === "string" ? route.query.token : "";
  if (!token) {
    state.value = "error";
    error.value = t("verifyEmail.missingToken");
    return;
  }
  const result = await confirmEmailVerify(token);
  if (result.ok) {
    state.value = "success";
  } else {
    state.value = "error";
    error.value = result.error || t("verifyEmail.failed");
  }
});
</script>

<template>
  <div class="login-view">
    <div class="login-main">
      <div class="login-card">
        <div class="login-header">
          <div class="login-logo">
            <img src="/logo.svg" alt="EdgeSonic" class="login-logo-img" />
            <span class="logo-text">EDGESONIC</span>
          </div>
        </div>

        <div class="login-form">
          <p v-if="state === 'checking'" class="login-hint">{{ t("common.loading") }}</p>
          <p v-else-if="state === 'success'" class="login-hint">{{ t("verifyEmail.successHint") }}</p>
          <div v-else class="login-error" role="alert">
            <span class="login-error-mark" aria-hidden="true">!</span>
            <span>{{ error }}</span>
          </div>

          <router-link :to="isLoggedIn ? '/' : '/login'" class="btn-primary login-btn">
            {{ isLoggedIn ? t("common.back") : t("register.backToLogin") }}
          </router-link>
        </div>

        <div class="corner corner-tl"></div>
        <div class="corner corner-tr"></div>
        <div class="corner corner-bl"></div>
        <div class="corner corner-br"></div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.login-view {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  background: var(--color-bg-primary);
  background-image:
    linear-gradient(var(--color-border-subtle) 1px, transparent 1px),
    linear-gradient(90deg, var(--color-border-subtle) 1px, transparent 1px);
  background-size: 64px 64px;
}
.login-main { flex: 1; display: flex; align-items: center; justify-content: center; padding: 1rem; }
.login-card {
  position: relative;
  width: 100%;
  max-width: 400px;
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border-subtle);
  border-radius: 2px;
}
.login-header { padding: 2rem 2rem 1rem; text-align: center; border-bottom: 1px solid var(--color-border-subtle); }
.login-logo { display: flex; flex-direction: column; align-items: center; gap: 0.75rem; margin-bottom: 0.5rem; }
.login-logo-img { height: 96px; width: 96px; object-fit: contain; }
.login-logo .logo-text {
  font-family: var(--font-mono); font-size: 1.5rem; font-weight: 700;
  color: var(--color-accent-primary); letter-spacing: 0.15em;
}
.login-form { padding: 1.5rem 2rem 2rem; display: flex; flex-direction: column; gap: 1rem; }
.login-hint { color: var(--color-text-secondary); font-size: var(--fs-sm); text-align: center; margin: 0 0 0.5rem; }
.login-error {
  display: flex; align-items: center; gap: 0.65rem;
  background: var(--color-bg-elevated); border: 1px solid var(--color-status-error);
  box-shadow: inset 3px 0 var(--color-status-error), 0 8px 18px rgba(0, 0, 0, 0.18);
  color: var(--color-text-primary); font-family: var(--font-mono); font-size: var(--fs-sm);
  font-weight: 600; padding: 0.7rem 0.8rem; border-radius: 2px;
}
.login-error-mark {
  display: grid; width: 1.2rem; height: 1.2rem; place-items: center; flex: 0 0 auto;
  border: 1px solid currentColor; color: var(--color-status-error); font-weight: 700;
}
.login-btn { width: 100%; margin-top: 0.5rem; text-align: center; text-decoration: none; }
</style>
