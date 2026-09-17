<script setup>
import { computed } from 'vue'

import StatusChip from './StatusChip.vue'

/**
 * A running stage, rendered as a thin determinate bar with counts.
 *
 * Shows `done / total` as real numbers rather than only a percentage: "142 of
 * 300" tells an operator whether it is worth waiting, and a percentage alone
 * does not. Falls back to an indeterminate bar before the total is known,
 * which is the first second or so of every run.
 */
const props = defineProps({
  job: { type: Object, default: null },
})

const percent = computed(() => props.job?.percent ?? null)
const indeterminate = computed(() => props.job?.status === 'running' && percent.value === null)
</script>

<template>
  <div v-if="job" class="job">
    <div class="spread">
      <div class="row">
        <StatusChip :status="job.status" />
        <span class="job__stage num">{{ job.stage }}</span>
      </div>
      <span v-if="job.total > 0" class="job__counts num">
        {{ job.progress }} / {{ job.total }}
      </span>
    </div>

    <div
      v-if="!job.isTerminal"
      class="job__track"
      :class="{ 'job__track--indeterminate': indeterminate }"
      role="progressbar"
      :aria-valuenow="percent ?? undefined"
      aria-valuemin="0"
      aria-valuemax="100"
    >
      <div
        class="job__fill"
        :style="indeterminate ? undefined : { inlineSize: `${percent}%` }"
      ></div>
    </div>

    <p v-if="job.errorMessage" class="job__error">{{ job.errorMessage }}</p>
  </div>
</template>

<style scoped>
.job {
  display: grid;
  gap: var(--space-3);
}

.job__stage,
.job__counts {
  font-size: var(--text-micro);
  color: var(--ink-muted);
}

.job__track {
  position: relative;
  block-size: 0.25rem;
  background: var(--paper-sunk);
  border-radius: 1px;
  overflow: hidden;
}

.job__fill {
  block-size: 100%;
  background: var(--accent);
  transition: inline-size var(--duration) var(--ease-out);
}

/* Indeterminate: a sliver sweeping across. Animates transform only, so it
 * stays on the compositor and costs nothing while a long stage runs. */
.job__track--indeterminate .job__fill {
  inline-size: 30%;
  animation: sweep 1.2s var(--ease-out) infinite;
}

@keyframes sweep {
  from {
    transform: translateX(-100%);
  }
  to {
    transform: translateX(333%);
  }
}

.job__error {
  padding: var(--space-3) var(--space-4);
  border-left: 2px solid var(--danger);
  background: var(--danger-wash);
  font-size: var(--text-sm);
  color: var(--ink);
  /* Server error text can be long and is not pre-wrapped. */
  overflow-wrap: anywhere;
}
</style>
