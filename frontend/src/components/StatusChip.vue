<script setup>
import { computed } from 'vue'

/**
 * Status as a typographic chip: small caps, a hairline, a wash.
 *
 * Colour is semantic and consistent with the tokens — amber means a human is
 * needed, green means done, red means a problem, neutral means nothing is
 * required. Colour is never the only channel: the label is always present, so
 * this works in greyscale and for a colour-blind reader.
 */
const props = defineProps({
  status: { type: String, required: true },
})

/** Extend for your own states. Unknown values fall back to neutral. */
const TONES = {
  open: 'neutral',
  recognizing: 'busy',
  in_review: 'attention',
  needs_review: 'attention',
  ready: 'ok',
  recognized: 'ok',
  approved: 'ok',
  exported: 'ok',
  succeeded: 'ok',
  archived: 'neutral',
  pending: 'neutral',
  queued: 'neutral',
  running: 'busy',
  rejected: 'danger',
  failed: 'danger',
  cancelled: 'danger',
}

const tone = computed(() => TONES[props.status] ?? 'neutral')
const label = computed(() => props.status.replace(/_/g, ' '))
</script>

<template>
  <span class="chip" :data-tone="tone">
    <span class="chip__dot" aria-hidden="true"></span>
    {{ label }}
  </span>
</template>

<style scoped>
.chip {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  padding: 0.125rem var(--space-3);
  border: 1px solid var(--chip-line);
  border-radius: var(--radius-sharp);
  background: var(--chip-wash);
  color: var(--chip-ink);
  font-size: var(--text-micro);
  font-weight: 600;
  letter-spacing: var(--tracking-caps);
  text-transform: uppercase;
  white-space: nowrap;
}

.chip__dot {
  inline-size: 0.3125rem;
  block-size: 0.3125rem;
  border-radius: 50%;
  background: currentColor;
}

/* The busy state pulses, which is the one place motion carries meaning here:
 * it says "this is still happening" without a spinner. */
.chip[data-tone='busy'] .chip__dot {
  animation: pulse 1.4s ease-in-out infinite;
}

@keyframes pulse {
  50% {
    opacity: 0.25;
  }
}

.chip[data-tone='neutral'] {
  --chip-wash: var(--paper-sunk);
  --chip-line: var(--rule);
  --chip-ink: var(--ink-muted);
}

.chip[data-tone='attention'] {
  --chip-wash: var(--attention-wash);
  --chip-line: color-mix(in oklch, var(--attention) 45%, transparent);
  --chip-ink: color-mix(in oklch, var(--attention) 70%, var(--ink));
}

.chip[data-tone='ok'] {
  --chip-wash: var(--ok-wash);
  --chip-line: color-mix(in oklch, var(--ok) 40%, transparent);
  --chip-ink: color-mix(in oklch, var(--ok) 70%, var(--ink));
}

.chip[data-tone='danger'] {
  --chip-wash: var(--danger-wash);
  --chip-line: color-mix(in oklch, var(--danger) 45%, transparent);
  --chip-ink: color-mix(in oklch, var(--danger) 70%, var(--ink));
}

.chip[data-tone='busy'] {
  --chip-wash: var(--accent-wash);
  --chip-line: color-mix(in oklch, var(--accent) 40%, transparent);
  --chip-ink: color-mix(in oklch, var(--accent) 75%, var(--ink));
}
</style>
