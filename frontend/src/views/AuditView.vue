<script setup>
import { onMounted, ref } from 'vue'

import { adminApi } from '../api'

/**
 * Audit log reader. Admin only, read only — there is no write or delete
 * endpoint by design.
 *
 * Filters live in component state rather than the URL to keep this short. For
 * a page people share links to ("look at what happened at 14:20"), move them
 * into query params — see the URL-as-state note in ARCHITECTURE.md.
 */
const entries = ref([])
const actions = ref([])
const total = ref(0)
const offset = ref(0)
const loading = ref(true)
const error = ref('')
const filters = ref({ action: '', from: '', to: '' })

const PAGE_SIZE = 50

async function load(reset = true) {
  loading.value = true
  error.value = ''
  if (reset) offset.value = 0
  try {
    const params = { limit: PAGE_SIZE, offset: offset.value }
    for (const [key, value] of Object.entries(filters.value)) {
      if (value) params[key] = value
    }
    const result = await adminApi.audit(params)
    entries.value = reset ? result.entries : [...entries.value, ...result.entries]
    total.value = result.total
  } catch (requestError) {
    error.value = requestError.userMessage ?? 'Could not load the audit log.'
  } finally {
    loading.value = false
  }
}

async function loadMore() {
  offset.value += PAGE_SIZE
  await load(false)
}

onMounted(async () => {
  // The action list comes from the data, so the filter can never drift out of
  // step with what is actually being recorded.
  try {
    actions.value = (await adminApi.auditActions()).actions
  } catch {
    actions.value = []
  }
  await load()
})
</script>

<template>
  <div class="stack">
    <header>
      <p class="eyebrow">Administration</p>
      <h1 class="page-title">Audit log</h1>
    </header>

    <form class="filters" @submit.prevent="load()">
      <div class="field">
        <label for="f-action">Action</label>
        <select id="f-action" v-model="filters.action" class="input">
          <option value="">All</option>
          <option v-for="action in actions" :key="action" :value="action">{{ action }}</option>
        </select>
      </div>
      <div class="field">
        <label for="f-from">From</label>
        <input id="f-from" v-model="filters.from" class="input num" type="date" />
      </div>
      <div class="field">
        <label for="f-to">To</label>
        <input id="f-to" v-model="filters.to" class="input num" type="date" />
      </div>
      <button class="btn" type="submit">Apply</button>
    </form>

    <p v-if="error" class="banner" role="alert">{{ error }}</p>

    <section class="panel">
      <div class="panel__head">
        <h2 class="panel__title">Entries</h2>
        <span class="eyebrow">{{ total }} total</span>
      </div>

      <p v-if="loading && entries.length === 0" class="empty">Loading…</p>
      <p v-else-if="entries.length === 0" class="empty">Nothing recorded for these filters.</p>

      <div v-else class="tablewrap">
        <table class="table">
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">Who</th>
              <th scope="col">Action</th>
              <th scope="col">Resource</th>
              <th scope="col">Status</th>
              <th scope="col">Request</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="entry in entries" :key="entry.id">
              <td class="num nowrap">{{ entry.occurredAt }}</td>
              <td class="num">{{ entry.username ?? '—' }}</td>
              <td>{{ entry.action }}</td>
              <td class="num muted">
                {{ entry.resourceType ?? '' }}
                <template v-if="entry.resourceId">/ {{ entry.resourceId }}</template>
              </td>
              <td class="num" :class="{ bad: entry.statusCode >= 400 }">{{ entry.statusCode }}</td>
              <!-- The request id is the join key to the server logs: copyable
                   on purpose, because it is what turns "something failed" into
                   one grep. -->
              <td class="num muted">{{ entry.requestId }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-if="entries.length < total" class="more">
        <button class="btn" type="button" :disabled="loading" @click="loadMore">
          Load {{ Math.min(PAGE_SIZE, total - entries.length) }} more
        </button>
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

.filters {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto auto;
  align-items: end;
  gap: var(--space-4);
  padding: var(--space-4) var(--space-5);
  border: 1px solid var(--rule);
  border-radius: var(--radius-panel);
  background: var(--paper-sunk);
}

.filters .input {
  width: auto;
  padding: var(--space-2) var(--space-3);
  font-size: var(--text-sm);
}

.tablewrap {
  overflow-x: auto;
  max-height: 34rem;
  overflow-y: auto;
}

.nowrap {
  white-space: nowrap;
}

.muted {
  color: var(--ink-muted);
}

.bad {
  color: var(--danger);
  font-weight: 600;
}

.more {
  display: flex;
  justify-content: center;
  padding: var(--space-4);
  border-top: 1px solid var(--rule);
}

.banner {
  padding: var(--space-3) var(--space-4);
  border-left: 2px solid var(--danger);
  background: var(--danger-wash);
  font-size: var(--text-sm);
}

@media (max-width: 56rem) {
  .filters {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
