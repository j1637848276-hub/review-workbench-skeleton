<script setup>
import { RouterLink } from 'vue-router'
</script>

<template>
  <div class="nf">
    <p class="nf__code num">404</p>
    <h1 class="nf__title">No such page</h1>
    <p class="nf__body">
      The address may be mistyped, or the batch it pointed at has been deleted.
    </p>
    <RouterLink class="btn" :to="{ name: 'dashboard' }">Back to batches</RouterLink>
  </div>
</template>

<style scoped>
.nf {
  display: grid;
  gap: var(--space-4);
  justify-items: start;
  align-content: center;
  min-height: 100vh;
  max-width: 32rem;
  padding: var(--space-8) var(--space-6);
  margin: 0 auto;
}

/* Oversized, low-contrast numeral as the visual anchor — scale contrast
   instead of an illustration. */
.nf__code {
  font-size: clamp(4rem, 3rem + 8vw, 9rem);
  font-weight: 600;
  line-height: 0.85;
  letter-spacing: -0.05em;
  color: var(--rule-strong);
}

.nf__title {
  font-size: var(--text-display);
  font-weight: 650;
  line-height: var(--leading-tight);
  letter-spacing: -0.02em;
}

.nf__body {
  color: var(--ink-muted);
}
</style>
