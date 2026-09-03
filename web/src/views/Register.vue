
<script setup lang="ts">
// SPDX-License-Identifier: AGPL-3.0-or-later
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { useAuth } from "../api";
import { mapActivationError, registerGateHint } from "../lib/activation";

const { t } = useI18n();
const { register, isLoggedIn, getLoginConfig } = useAuth();
const router = useRouter();

if (isLoggedIn.value) router.push("/");

const username = ref("");
const email = ref("");
const password = ref("");
const confirmPassword = ref("");
const inviteCode = ref("");
const error = ref("");
const loading = ref(false);
const checkingConfig = ref(true);
const registrationEnabled = ref(false);
const activationEnabled = ref(false);
const gateMode = ref<"all" | "any">("all");
const emailVerificationOn = ref(false);
// Older backends don't announce the activation gate in loginConfig; when a
// registration attempt bounces on the invite requirement we reveal the field.
const inviteForcedVisible = ref(false);

const showInviteField = computed(() => activationEnabled.value || inviteForcedVisible.value);
const gateHintKey = computed(() => {
  const hint = registerGateHint(gateMode.value, emailVerificationOn.value, showInviteField.value);
  return hint ? `register.gate.${hint}` : "";
});

onMounted(async () => {
  const cfg = await getLoginConfig();
  registrationEnabled.value = cfg.registrationEnabled;
  activationEnabled.value = cfg.activationEnabled;
  gateMode.value = cfg.registrationGateMode;
  emailVerificationOn.value = cfg.emailEnabled;
  checkingConfig.value = false;
});

async function submit() {
  error.value = "";
  if (password.value !== confirmPassword.value) {
    error.value = t("register.passwordMismatch");
    return;
  }
  loading.value = true;
  try {
    const result = await register(username.value, email.value, password.value, inviteCode.value.trim() || undefined);
    if (result.ok) { router.push("/login"); return; }
    const key = result.error ? mapActivationError(result.error) : null;
    if (key === "activation.errors.inviteRequired") inviteForcedVisible.value = true;
    error.value = key ? t(key) : (result.error || t("register.failed"));
  } catch {
    error.value = t("register.failed");
  } finally {
    loading.value = false;
  }
}
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

        <div v-if="checkingConfig" class="login-form">
          <p class="login-hint">{{ t("common.loading") }}</p>
        </div>
        <div v-else-if="!registrationEnabled" class="login-form">
          <p class="login-hint">{{ t("register.disabled") }}</p>
          <router-link to="/login" class="btn-secondary login-btn">{{ t("register.backToLogin") }}</router-link>
        </div>
        <form v-else @submit.prevent="submit" class="login-form">
          <p v-if="gateHintKey" class="login-hint gate-hint">{{ t(gateHintKey) }}</p>
          <div v-if="error" class="login-error" role="alert">
            <span class="login-error-mark" aria-hidden="true">!</span>
            <span>{{ error }}</span>
          </div>

          <div class="form-group">
            <label class="form-label">{{ t("login.username") }}</label>
            <input v-model="username" maxlength="32" class="form-input" autocomplete="username" :disabled="loading" />
          </div>
          <div class="form-group">
            <label class="form-label">{{ t("register.email") }}</label>
            <input v-model="email" type="email" maxlength="256" class="form-input" autocomplete="email" :disabled="loading" />
          </div>
          <div class="form-group">
            <label class="form-label">{{ t("login.password") }}</label>
            <input v-model="password" type="password" maxlength="256" class="form-input" autocomplete="new-password" :disabled="loading" />
          </div>
          <div class="form-group">
            <label class="form-label">{{ t("register.confirmPassword") }}</label>
            <input v-model="confirmPassword" type="password" maxlength="256" class="form-input" autocomplete="new-password" :disabled="loading" />
          </div>
          <div v-if="showInviteField" class="form-group">
            <label class="form-label">
              {{ t("register.inviteCode") }}
              <span v-if="gateMode === 'any'" class="invite-optional">({{ t("common.optional") }})</span>
            </label>
            <input
              v-model="inviteCode"
              maxlength="64"
              class="form-input invite-input"
              :placeholder="t('register.inviteCodePlaceholder')"
              autocomplete="off"
              spellcheck="false"
              :disabled="loading"
            />
          </div>
          <button type="submit" class="btn-primary login-btn" :disabled="loading || !username || !email || !password">
            {{ loading ? t("register.submitting") : t("register.submit") }}
          </button>
          <router-link to="/login" class="login-register-hint">{{ t("register.backToLogin") }}</router-link>
        </form>

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
.login-register-hint {
  text-align: center; margin-top: 0.25rem; font-size: var(--fs-sm);
  color: var(--color-accent-primary); text-decoration: none;
}
.login-register-hint:hover { text-decoration: underline; }
.gate-hint { margin: 0; }
.invite-input { font-family: var(--font-mono); letter-spacing: 0.08em; text-transform: uppercase; }
.invite-optional { color: var(--color-text-muted); font-weight: 400; }
</style>
