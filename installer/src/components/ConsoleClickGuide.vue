<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
defineProps<{
  heading: string;
  action: string;
  detail: string;
  masked?: string;
}>();
</script>

<template>
  <figure class="console-guide">
    <div class="browser-bar"><i /><i /><i /><span>dash.cloudflare.com</span></div>
    <div class="console-body">
      <aside><strong>Cloudflare</strong><span>Websites</span><span>Workers & Pages</span><span>R2 Object Storage</span><span>Manage Account</span></aside>
      <section>
        <p class="console-heading">{{ heading }}</p>
        <div v-if="masked" class="masked-value"><span>{{ masked }}</span><i /></div>
        <div class="console-row"><span>{{ detail }}</span><b>{{ action }}</b><em>1</em></div>
        <svg class="callout-arrow" viewBox="0 0 100 36" aria-hidden="true"><path d="M8 4 C30 34, 70 34, 90 14" /><path class="arrow-head" d="M83 13 L91 13 L88 20 Z" /></svg>
        <div class="console-row muted"><span>Cloudflare dashboard</span></div>
        <div class="console-row muted"><span>Account settings</span></div>
      </section>
    </div>
    <figcaption><span>1</span>{{ action }}</figcaption>
  </figure>
</template>

<style scoped>
.console-guide { margin: 14px 0; border: 1px solid #cfd5df; border-radius: 10px; overflow: hidden; background: #fff; color: #202a3a; font-size: 12px; }
.browser-bar { height: 28px; display: flex; align-items: center; gap: 5px; padding: 0 10px; background: #eef1f5; border-bottom: 1px solid #d8dde5; }
.browser-bar i { width: 7px; height: 7px; border-radius: 50%; background: #bcc4d0; }
.browser-bar span { margin-left: 8px; color: #667085; font-size: 11px; }
.console-body { display: grid; grid-template-columns: 135px 1fr; min-height: 162px; }
aside { padding: 13px 10px; background: #f8f9fb; border-right: 1px solid #e1e5eb; display: flex; flex-direction: column; gap: 8px; color: #596275; }
aside strong { color: #f48120; font-size: 13px; } section { padding: 14px; } .console-heading { margin: 0 0 12px; font-size: 15px; font-weight: 700; }
.masked-value { display: inline-flex; align-items: center; gap: 6px; color: #667085; font-size: 10px; margin: -5px 0 6px; } .masked-value i { width: 72px; height: 8px; background: #1f2937; border-radius: 2px; }
.console-row { position: relative; min-height: 34px; display: flex; align-items: center; justify-content: space-between; border: 1px solid #e1e5eb; padding: 7px 10px; margin-top: 7px; }
.console-row b { background: #f48120; color: #fff; padding: 5px 9px; border-radius: 4px; font-size: 11px; }
.console-row em { position: absolute; right: -8px; top: -9px; width: 19px; height: 19px; border-radius: 50%; background: #c93838; color: #fff; display: grid; place-items: center; font-style: normal; font-weight: 700; }
.callout-arrow { position: absolute; width: 100px; height: 36px; right: 2px; top: 78px; overflow: visible; } .callout-arrow path { fill: none; stroke: #c93838; stroke-width: 2.5; } .callout-arrow .arrow-head { fill: #c93838; stroke: none; }
.console-row.muted { color: #8993a4; } .console-row.muted::after { content: ""; width: 60px; height: 6px; background: #e9edf2; }
figcaption { padding: 8px 10px; background: #fff7ed; color: #88410a; font-weight: 600; } figcaption span { display: inline-grid; place-items: center; width: 17px; height: 17px; margin-right: 5px; border-radius: 50%; background: #c93838; color: #fff; }
@media (max-width: 440px) { .console-body { grid-template-columns: 96px 1fr; } aside { padding: 10px 7px; font-size: 10px; } }
</style>
