<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
defineProps<{ label: string }>();
</script>

<template>
  <div class="screenshot-placeholder">{{ label }}</div>
</template>
