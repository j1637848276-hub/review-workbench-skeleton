<script setup>
import { computed, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'

import { batchApi, newIdempotencyKey } from '../api'
import { useAuthStore } from '../stores/auth'
import { useJobPolling } from '../composables/useJobPolling'
import JobProgress from '../components/JobProgress.vue'
import StatusChip from '../components/StatusChip.vue'

const props = defineProps({ id: { type: String, required: true } })

const auth = useAuthStore()
const { job, watch: watchJob } = useJobPolling()

const batch = ref(null)
const documents = ref([])
const jobs = ref([])
const exportPlans = ref([])
const selectedPlan = ref('')
const loading = ref(true)
const error = ref('')
const notice = ref('')

const uploadPercent = ref(null)
const fileInput = ref(null)

const canEdit = computed(() => auth.can('reviewer') && batch.value && !batch.value.isLocked)
const pendingCount = computed(
  () => documents.value.filter((document) => document.status === 'pending').length
)

async function load() {
  loading.value = true
  try {
    const result = await batchApi.get(props.id)
    batch.value = result.batch
    documents.value = result.documents.documents
    jobs.value = result.jobs
    exportPlans.value = result.exportPlans
    selectedPlan.value ||= result.exportPlans[0]?.id ?? ''
  } catch (requestError) {
    error.value = requestError.userMessage ?? 'Could not load the batch.'
  } finally {
    loading.value = false
  }
}

async function upload(event) {
  const files = [...(event.target.files ?? [])]
  if (files.length === 0) return

  error.value = ''
  notice.value = ''
  uploadPercent.value = 0
  try {
    const result = await batchApi.uploadDocuments(props.id, files, (percent) => {
      uploadPercent.value = percent
    })
    // Report all three counts. "Uploaded 300 files" when 40 were duplicates is
    // the kind of half-truth that costs a day of reconciliation later.
    const parts = [`${result.accepted} accepted`]
    if (result.duplicates?.length) parts.push(`${result.duplicates.length} duplicate`)
    if (result.failed?.length) parts.push(`${result.failed.length} failed`)
    notice.value = parts.join(', ')
    await load()
  } catch (requestError) {
    error.value = requestError.userMessage ?? 'Upload failed.'
  } finally {
    uploadPercent.value = null
    // Reset so selecting the same folder twice re-fires the change event.
    if (fileInput.value) fileInput.value.value = ''
  }
}

async function runStage(action) {
  error.value = ''
  notice.value = ''
  try {
    const key = newIdempotencyKey()
    const started =
      action === 'recognize'
        ? await batchApi.recognize(props.id, key)
        : await batchApi.export(props.id, selectedPlan.value, key)

    if (started.reused) notice.value = 'That run was already started — showing its progress.'
    await watchJob(props.id, started.jobId)
    await load()
  } catch (requestError) {
    error.value = requestError.userMessage ?? 'Could not start the stage.'
  }
}

async function toggleLock() {
  error.value = ''
  try {
    batch.value = batch.value.isLocked
      ? await batchApi.unlock(props.id)
      : await batchApi.lock(props.id)
  } catch (requestError) {
    error.value = requestError.userMessage ?? 'Could not change the lock.'
  }
}

onMounted(load)
</script>

<template>
  <div v-if="loading" class="empty">Loading…</div>

  <div v-else-if="batch" class="stack">
    <header class="head">
      <div>
        <p class="eyebrow">
          <RouterLink :to="{ name: 'dashboard' }">Batches</RouterLink>
          <span aria-hidden="true"> / </span>
          <span class="num">{{ batch.id }}</span>
        </p>
        <h1 class="head__title">{{ batch.label }}</h1>
        <div class="row head__meta">
          <StatusChip :status="batch.status" />
          <span class="num muted">{{ batch.businessDay }}</span>
          <span class="num muted">{{ documents.length }} documents</span>
        </div>
      </div>

      <!-- Sticky command bar: the actions stay reachable while the document
           table scrolls, which is the whole reason this page is not a stack of
           equal-weight cards. -->
      <div class="commands">
        <label class="btn" :class="{ 'btn--disabled': !canEdit }">
          <input
            ref="fileInput"
            type="file"
            multiple
            class="sr-only"
            :disabled="!canEdit"
            @change="upload"
          />
          {{ uploadPercent === null ? 'Add documents' : `Uploading ${uploadPercent}%` }}
        </label>

        <button
          class="btn btn--primary"
          type="button"
          :disabled="!canEdit || pendingCount === 0"
          @click="runStage('recognize')"
        >
          Recognize{{ pendingCount > 0 ? ` (${pendingCount})` : '' }}
        </button>

        <span class="commands__group">
          <select v-model="selectedPlan" class="input plan" aria-label="Export plan">
            <option v-for="plan in exportPlans" :key="plan.id" :value="plan.id">
              {{ plan.title }}
            </option>
          </select>
          <button class="btn" type="button" :disabled="!selectedPlan" @click="runStage('export')">
            Export
          </button>
        </span>

        <button
          v-if="auth.can('reviewer')"
          class="btn btn--ghost"
          type="button"
          @click="toggleLock"
        >
          {{ batch.isLocked ? 'Unlock' : 'Lock' }}
        </button>
      </div>
    </header>

    <p v-if="batch.isLocked" class="banner" role="status">
      This batch is locked — its numbers have been reported. Unlock it to make changes.
    </p>
    <p v-if="error" class="banner banner--danger" role="alert">{{ error }}</p>
    <p v-if="notice" class="banner banner--ok" role="status">{{ notice }}</p>

    <section v-if="job" class="panel">
      <div class="panel__head"><h2 class="panel__title">Current run</h2></div>
      <div class="panel__body"><JobProgress :job="job" /></div>
    </section>

    <section class="panel">
      <div class="panel__head">
        <h2 class="panel__title">Documents</h2>
        <RouterLink
          v-if="auth.can('reviewer')"
          :to="{ name: 'review', query: { batchId: batch.id } }"
        >
          Open review queue
        </RouterLink>
      </div>

      <p v-if="documents.length === 0" class="empty">
        No documents yet. Add files with the button above.
      </p>

      <div v-else class="tablewrap">
        <table class="table">
          <thead>
            <tr>
              <th scope="col">File</th>
              <th scope="col">Type</th>
              <th scope="col">Status</th>
              <th scope="col">Page</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="document in documents" :key="document.id">
              <td>
                <RouterLink :to="{ name: 'review', query: { documentId: document.id } }">
                  {{ document.originalName }}
                </RouterLink>
              </td>
              <td class="muted">{{ document.docType ?? '—' }}</td>
              <td><StatusChip :status="document.status" /></td>
              <td class="num">{{ document.pageNumber }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section v-if="jobs.length > 0" class="panel">
      <div class="panel__head"><h2 class="panel__title">Recent runs</h2></div>
      <div class="tablewrap">
        <table class="table">
          <thead>
            <tr>
              <th scope="col">Stage</th>
              <th scope="col">Status</th>
              <th scope="col">Progress</th>
              <th scope="col">Finished</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in jobs" :key="row.id">
              <td class="num">{{ row.stage }}</td>
              <td><StatusChip :status="row.status" /></td>
              <td class="num">{{ row.total > 0 ? `${row.progress}/${row.total}` : '—' }}</td>
              <td class="num muted">{{ row.finishedAt ?? '—' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>

<style scoped>
.head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--space-6);
  flex-wrap: wrap;
}

.head__title {
  font-size: var(--text-lg);
  font-weight: 650;
  letter-spacing: -0.01em;
}

.head__meta {
  margin-top: var(--space-2);
}

.commands {
  position: sticky;
  top: var(--space-3);
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
}

.commands__group {
  display: flex;
  align-items: stretch;
  gap: 0;
}

/* Joined select + button: they are one action, so they read as one control. */
.commands__group .plan {
  width: auto;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius) 0 0 var(--radius);
  border-right: none;
  font-size: var(--text-sm);
}

.commands__group .btn {
  border-radius: 0 var(--radius) var(--radius) 0;
}

/* A <label> wrapping a file input cannot be :disabled, so mirror the look. */
.btn--disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.panel__body {
  padding: var(--space-5);
}

.tablewrap {
  overflow-x: auto;
  max-height: 32rem;
  overflow-y: auto;
}

.muted {
  color: var(--ink-muted);
}

.banner {
  padding: var(--space-3) var(--space-4);
  border-left: 2px solid var(--attention);
  background: var(--attention-wash);
  font-size: var(--text-sm);
}

.banner--danger {
  border-color: var(--danger);
  background: var(--danger-wash);
}

.banner--ok {
  border-color: var(--ok);
  background: var(--ok-wash);
}
</style>
