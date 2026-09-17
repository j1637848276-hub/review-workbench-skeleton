<script setup>
import { computed } from 'vue'

/**
 * Confidence as a short inline bar plus the number.
 *
 * A coloured badge ("high" / "low") throws away the information that matters:
 * an operator triaging a queue needs to see that 0.62 and 0.84 are different
 * problems. The bar gives a scannable magnitude, the number gives the exact
 * value, and the threshold marker shows where the auto-approve line sits — so
 * "why did this one need review" is answerable at a glance.
 */
const props = defineProps({
  value: { type: Number, default: null },
  threshold: { type: Number, default: 0.85 },
})

const pct = computed(() => (props.value == null ? 0 : Math.round(props.value * 100)))

const tone = computed(() => {
  if (props.value == null) return 'unknown'
  if (props.value >= props.threshold) return 'ok'
  // Well below the line is a different situation from just under it: one is a
  // glance, the other is a careful read against the original.
  return props.value >= props.threshold - 0.15 ? 'attention' : 'danger'
})
</script>

<template>
  <div
    class="meter"
    :data-tone="tone"
    role="meter"
    :aria-valuenow="pct"
    aria-valuemin="0"
    aria-valuemax="100"
    :aria-label="`Confidence ${pct}%`"
  >
    <div class="meter__track">
      <div class="meter__fill" :style="{ inlineSize: `${pct}%` }"></div>
      <div class="meter__mark" :style="{ insetInlineStart: `${threshold * 100}%` }"></div>
    </div>
    <span class="meter__value num">{{ value == null ? '—' : `${pct}%` }}</span>
  </div>
</template>

<style scoped>
.meter {
  display: inline-flex;
  align-items: center;
  gap: var(--space-3);
}

.meter__track {
  position: relative;
  inline-size: 3.5rem;
  block-size: 0.375rem;
  background: var(--paper-sunk);
  border: 1px solid var(--rule);
  border-radius: 1px;
  overflow: hidden;
}

.meter__fill {
  block-size: 100%;
  background: var(--meter-color);
  /* Width is animated only on mount-time value changes and the bar is 56px
   * wide, so the layout cost is negligible; transform-scaling it would blur
   * the 1px threshold marker. */
  transition: inline-size var(--duration) var(--ease-out);
}

/* The auto-approve line. Notched through the fill so it stays visible either
 * side of the threshold. */
.meter__mark {
  position: absolute;
  inset-block: 0;
  inline-size: 1px;
  background: var(--ink);
  opacity: 0.45;
}

.meter__value {
  font-size: var(--text-micro);
  color: var(--ink-muted);
  min-inline-size: 2.5rem;
}

.meter[data-tone='ok'] {
  --meter-color: var(--ok);
}

.meter[data-tone='attention'] {
  --meter-color: var(--attention);
}

.meter[data-tone='danger'] {
  --meter-color: var(--danger);
}

.meter[data-tone='unknown'] {
  --meter-color: var(--rule-strong);
}
</style>
