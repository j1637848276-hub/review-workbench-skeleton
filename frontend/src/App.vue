<script setup>
import { ref, onMounted, onUnmounted } from 'vue'

import { onAppUpdated } from './api/client'

/**
 * The deploy banner.
 *
 * This app stays open for days on an operator's second monitor. After a deploy
 * that tab is still running the old bundle, so a bug you fixed this morning
 * keeps getting reported and you cannot reproduce it. The server stamps every
 * response with a per-process `X-App-Boot`; when it changes, this appears.
 *
 * It is a banner rather than a forced reload on purpose: reloading out from
 * under someone who is mid-correction loses their work.
 */
const updateAvailable = ref(false)
let unsubscribe = null

onMounted(() => {
  unsubscribe = onAppUpdated(() => {
    updateAvailable.value = true
  })
})

onUnmounted(() => unsubscribe?.())

function reload() {
  window.location.reload()
}
</script>

<template>
  <div v-if="updateAvailable" class="deploy-banner" role="status" aria-live="polite">
    <span class="deploy-banner__text"> A new version of the workbench is available. </span>
    <button class="btn btn--sm" type="button" @click="reload">Reload</button>
  </div>

  <RouterView />
</template>

<style scoped>
.deploy-banner {
  position: sticky;
  top: 0;
  z-index: 50;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-4);
  padding: var(--space-3) var(--space-5);
  /* Amber: this needs a human, which is exactly what the token means. */
  background: var(--attention-wash);
  border-bottom: 1px solid var(--attention);
  font-size: var(--text-sm);
}

.deploy-banner__text {
  font-weight: 500;
}
</style>
