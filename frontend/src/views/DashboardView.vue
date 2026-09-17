<script setup>
import { computed, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'

import { batchApi } from '../api'
import { useAuthStore } from '../stores/auth'
import StatusChip from '../components/StatusChip.vue'

const auth = useAuthStore()

const batches = ref([])
const total = ref(0)
const loading = ref(true)
const error = ref('')
const statusFilter = ref('')

const creating = ref(false)
const draft = ref({ id: '', label: '', businessDay: new Date().toISOString().slice(0, 10) })

/** Summary figures, derived rather than stored — one source of truth. */
const summary = computed(() => ({
  batches: total.value,
  documents: batches.value.reduce((sum, batch) => sum + (batch.documentCount ?? 0), 0),
  needsReview: batches.value.reduce((sum, batch) => sum + (batch.needsReviewCount ?? 0), 0),
}))

async function load() {
  loading.value = true
  error.value = ''
  try {
    const result = await batchApi.list(statusFilter.value ? { status: statusFilter.value } : {})
    batches.value = result.batches
    total.value = result.total
  } catch (requestError) {
    error.value = requestError.userMessage ?? 'Could not load batches.'
  } finally {
    loading.value = false
  }
}

async function createBatch() {
  creating.value = true
  error.value = ''
  try {
    await batchApi.create({ ...draft.value })
    draft.value = { id: '', label: '', businessDay: draft.value.businessDay }
    await load()
  } catch (requestError) {
    // Show the server's message verbatim: it already says "already exists" or
    // exactly which field is wrong, which beats anything generic.
    error.value = requestError.userMessage ?? 'Could not create the batch.'
  } finally {
    creating.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="stack">
    <header class="spread">
      <div>
        <p class="eyebrow">Overview</p>
        <h1 class="page-title">Batches</h1>
      </div>
      <select
        v-model="statusFilter"
        class="input filter"
        aria-label="Filter by status"
        @change="load"
      >
        <option value="">All statuses</option>
        <option value="open">Open</option>
        <option value="in_review">In review</option>
        <option value="ready">Ready</option>
        <option value="exported">Exported</option>
      </select>
    </header>

    <!-- Three figures, not a wall of identical stat cards. The middle one is
         the one that matters, so it gets the accent. -->
    <dl class="figures">
      <div class="figure">
        <dt class="eyebrow">Batches</dt>
        <dd class="figure__value num">{{ summary.batches }}</dd>
      </div>
      <div class="figure figure--lead">
        <dt class="eyebrow">Awaiting review</dt>
        <dd class="figure__value num">{{ summary.needsReview }}</dd>
      </div>
      <div class="figure">
        <dt class="eyebrow">Documents</dt>
        <dd class="figure__value num">{{ summary.documents }}</dd>
      </div>
    </dl>

    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <section v-if="auth.can('reviewer')" class="panel">
      <div class="panel__head">
        <h2 class="panel__title">New batch</h2>
      </div>
      <form class="newbatch" @submit.prevent="createBatch">
        <div class="field">
          <label for="batch-id">Id</label>
          <input
            id="batch-id"
            v-model="draft.id"
            class="input num"
            placeholder="2026-09-17-a"
            required
          />
        </div>
        <div class="field">
          <label for="batch-label">Label</label>
          <input
            id="batch-label"
            v-model="draft.label"
            class="input"
            placeholder="Morning intake"
            required
          />
        </div>
        <div class="field">
          <label for="batch-day">Business day</label>
          <input
            id="batch-day"
            v-model="draft.businessDay"
            class="input num"
            type="date"
            required
          />
        </div>
        <button class="btn btn--primary" type="submit" :disabled="creating">
          {{ creating ? 'Creating…' : 'Create' }}
        </button>
      </form>
    </section>

    <section class="panel">
      <div class="panel__head">
        <h2 class="panel__title">All batches</h2>
        <span class="eyebrow">{{ total }} total</span>
      </div>

      <p v-if="loading" class="empty">Loading…</p>
      <p v-else-if="batches.length === 0" class="empty">
        No batches yet.
        <template v-if="auth.can('reviewer')">Create one above to get started.</template>
      </p>

      <div v-else class="tablewrap">
        <table class="table">
          <thead>
            <tr>
              <th scope="col">Batch</th>
              <th scope="col">Day</th>
              <th scope="col">Status</th>
              <th scope="col">Docs</th>
              <th scope="col">To review</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="batch in batches" :key="batch.id">
              <td>
                <RouterLink :to="{ name: 'batch', params: { id: batch.id } }" class="num">
                  {{ batch.id }}
                </RouterLink>
                <span class="rowlabel">{{ batch.label }}</span>
              </td>
              <td class="num">{{ batch.businessDay }}</td>
              <td>
                <div class="row">
                  <StatusChip :status="batch.status" />
                  <span v-if="batch.isLocked" class="lockmark" title="Locked">locked</span>
                </div>
              </td>
              <td class="num">{{ batch.documentCount ?? 0 }}</td>
              <td class="num" :class="{ 'num--attention': batch.needsReviewCount > 0 }">
                {{ batch.needsReviewCount ?? 0 }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>

<style scoped>
.page-title {
  font-size: var(--text-lg);
  font-weight: 650;
  letter-spacing: -0.01em;
}

.filter {
  width: auto;
  padding: var(--space-2) var(--space-3);
  font-size: var(--text-sm);
}

.figures {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
  gap: 1px;
  border: 1px solid var(--rule);
  border-radius: var(--radius-panel);
  background: var(--rule);
  overflow: hidden;
}

/* Hairline dividers come from the 1px grid gap over a rule-coloured
   background — no per-cell borders to keep in sync. */
.figure {
  padding: var(--space-4) var(--space-5);
  background: var(--paper-raised);
}

.figure--lead {
  background: var(--accent-wash);
}

.figure__value {
  font-size: 1.75rem;
  font-weight: 600;
  line-height: 1.1;
  letter-spacing: -0.03em;
}

.figure--lead .figure__value {
  color: var(--accent);
}

.newbatch {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr) auto auto;
  align-items: end;
  gap: var(--space-4);
  padding: var(--space-5);
}

.tablewrap {
  overflow-x: auto;
}

.rowlabel {
  display: block;
  font-size: var(--text-micro);
  color: var(--ink-faint);
}

.lockmark {
  font-size: var(--text-micro);
  letter-spacing: var(--tracking-caps);
  text-transform: uppercase;
  color: var(--ink-faint);
}

.num--attention {
  color: var(--attention);
  font-weight: 600;
}

.error {
  padding: var(--space-3) var(--space-4);
  border-left: 2px solid var(--danger);
  background: var(--danger-wash);
  font-size: var(--text-sm);
}

@media (max-width: 56rem) {
  .newbatch {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
