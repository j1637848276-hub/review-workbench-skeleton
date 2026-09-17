<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'

import { documentApi } from '../api'
import ConfidenceMeter from '../components/ConfidenceMeter.vue'
import StatusChip from '../components/StatusChip.vue'

/**
 * The review workspace: queue on the left, document and its fields on the
 * right.
 *
 * The layout is asymmetric and dense on purpose. This is the screen an
 * operator spends their day in, so the image and the fields have to be visible
 * at the same time — a modal or a separate page would mean looking away from
 * the document to type what it says, which is how transcription errors happen.
 *
 * Only *changed* fields are submitted. Sending every field would mark
 * untouched values as human-corrected and destroy the accuracy data the
 * `corrected` flag exists to collect.
 */
const route = useRoute()

const queue = ref([])
const selectedId = ref(null)
const detail = ref(null)
const drafts = ref({})
const loadingQueue = ref(true)
const loadingDetail = ref(false)
const saving = ref(false)
const error = ref('')

const threshold = 0.85

const dirtyKeys = computed(() =>
  Object.keys(drafts.value).filter((key) => {
    const field = detail.value?.fields.find((candidate) => candidate.key === key)
    return field && drafts.value[key] !== (field.value ?? '')
  })
)

async function loadQueue() {
  loadingQueue.value = true
  try {
    const params = {}
    if (typeof route.query.batchId === 'string') params.batchId = route.query.batchId
    const result = await documentApi.queue(params)
    queue.value = result.documents

    const requested = typeof route.query.documentId === 'string' ? route.query.documentId : null
    selectedId.value = requested ?? queue.value[0]?.id ?? null
  } catch (requestError) {
    error.value = requestError.userMessage ?? 'Could not load the queue.'
  } finally {
    loadingQueue.value = false
  }
}

async function loadDetail(id) {
  if (!id) {
    detail.value = null
    return
  }
  loadingDetail.value = true
  error.value = ''
  try {
    detail.value = await documentApi.get(id)
    drafts.value = Object.fromEntries(
      detail.value.fields.map((field) => [field.key, field.value ?? ''])
    )
  } catch (requestError) {
    error.value = requestError.userMessage ?? 'Could not load the document.'
  } finally {
    loadingDetail.value = false
  }
}

async function save() {
  if (dirtyKeys.value.length === 0) return
  saving.value = true
  error.value = ''
  try {
    const corrections = Object.fromEntries(dirtyKeys.value.map((key) => [key, drafts.value[key]]))
    const result = await documentApi.correct(
      selectedId.value,
      corrections,
      'reviewed against source'
    )
    // Re-seed from the server response: normalisation happens server-side, so
    // the stored value may differ from what was typed ("1,234.50" -> "1234.50")
    // and the input must show what was actually saved.
    detail.value.fields = result.fields
    drafts.value = Object.fromEntries(result.fields.map((field) => [field.key, field.value ?? '']))
  } catch (requestError) {
    error.value = requestError.userMessage ?? 'Could not save.'
  } finally {
    saving.value = false
  }
}

async function decide(decision) {
  saving.value = true
  error.value = ''
  try {
    if (dirtyKeys.value.length > 0) await save()
    await documentApi.review(selectedId.value, decision)

    // Advance to the next item rather than returning to an empty screen: the
    // queue is the task, and re-selecting by hand every time is friction that
    // adds up over 300 documents.
    const index = queue.value.findIndex((document) => document.id === selectedId.value)
    queue.value.splice(index, 1)
    selectedId.value = queue.value[Math.min(index, queue.value.length - 1)]?.id ?? null
  } catch (requestError) {
    error.value = requestError.userMessage ?? 'Could not record the decision.'
  } finally {
    saving.value = false
  }
}

watch(selectedId, loadDetail)
onMounted(loadQueue)
</script>

<template>
  <div class="review">
    <!-- Queue -->
    <aside class="review__queue panel">
      <div class="panel__head">
        <h2 class="panel__title">Queue</h2>
        <span class="eyebrow">{{ queue.length }}</span>
      </div>

      <p v-if="loadingQueue" class="empty">Loading…</p>
      <p v-else-if="queue.length === 0" class="empty">Nothing waiting. Queue is clear.</p>

      <ul v-else class="queue">
        <li v-for="document in queue" :key="document.id">
          <button
            class="queue__item"
            type="button"
            :aria-current="document.id === selectedId ? 'true' : undefined"
            @click="selectedId = document.id"
          >
            <span class="queue__name">{{ document.originalName }}</span>
            <ConfidenceMeter :value="document.minConfidence" :threshold="threshold" />
          </button>
        </li>
      </ul>
    </aside>

    <!-- Workspace -->
    <section v-if="detail" class="review__work">
      <header class="worktop">
        <div>
          <p class="eyebrow num">{{ detail.document.id }}</p>
          <h1 class="worktop__title">{{ detail.document.originalName }}</h1>
        </div>
        <div class="row">
          <StatusChip :status="detail.document.status" />
          <ConfidenceMeter :value="detail.document.minConfidence" :threshold="threshold" />
        </div>
      </header>

      <p v-if="error" class="banner banner--danger" role="alert">{{ error }}</p>

      <div class="workgrid">
        <!-- The document. Sticky so it stays in view while the field list
             scrolls — the two must be readable together. -->
        <figure class="viewer">
          <img
            :src="documentApi.fileUrl(detail.document.id)"
            :alt="`Scan of ${detail.document.originalName}`"
            loading="eager"
            fetchpriority="high"
          />
          <figcaption class="eyebrow">
            {{ detail.document.docType ?? 'unclassified' }} · page {{ detail.document.pageNumber }}
          </figcaption>
        </figure>

        <div class="fields">
          <div
            v-for="field in detail.fields"
            :key="field.key"
            class="fieldrow"
            :data-low="field.confidence < threshold && !field.corrected ? 'true' : undefined"
          >
            <label class="fieldrow__label" :for="`f-${field.key}`">
              {{ field.key.replace(/_/g, ' ') }}
            </label>

            <input
              :id="`f-${field.key}`"
              v-model="drafts[field.key]"
              class="input num"
              :disabled="!!detail.batch?.isLocked"
            />

            <div class="fieldrow__meta">
              <ConfidenceMeter :value="field.confidence" :threshold="threshold" />
              <!-- The model's verbatim output stays visible next to the
                   editable value: seeing what it read is how a reviewer
                   decides whether to trust it. -->
              <span
                v-if="field.rawValue && field.rawValue !== field.value"
                class="fieldrow__raw num"
              >
                model read: {{ field.rawValue }}
              </span>
              <span v-if="field.corrected" class="fieldrow__flag">corrected</span>
            </div>
          </div>

          <p v-if="detail.fields.length === 0" class="empty">
            No fields were extracted. Check the document and reject it if unusable.
          </p>
        </div>
      </div>

      <footer class="actions">
        <span class="actions__state" aria-live="polite">
          {{ dirtyKeys.length > 0 ? `${dirtyKeys.length} unsaved change(s)` : 'No changes' }}
        </span>
        <button
          class="btn"
          type="button"
          :disabled="saving || dirtyKeys.length === 0"
          @click="save"
        >
          Save
        </button>
        <button
          class="btn btn--danger"
          type="button"
          :disabled="saving"
          @click="decide('rejected')"
        >
          Reject
        </button>
        <button
          class="btn btn--primary"
          type="button"
          :disabled="saving"
          @click="decide('approved')"
        >
          Approve
        </button>
      </footer>
    </section>

    <section v-else-if="!loadingQueue" class="review__work">
      <p class="empty">Select a document from the queue.</p>
    </section>
  </div>
</template>

<style scoped>
/* Asymmetric two-column: a fixed-width queue and a fluid workspace. */
.review {
  display: grid;
  grid-template-columns: minmax(0, 19rem) minmax(0, 1fr);
  gap: var(--space-5);
  align-items: start;
}

.review__queue {
  position: sticky;
  top: 0;
  max-height: calc(100vh - 8rem);
  display: flex;
  flex-direction: column;
}

.queue {
  margin: 0;
  padding: 0;
  list-style: none;
  overflow-y: auto;
}

.queue__item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  inline-size: 100%;
  padding: var(--space-3) var(--space-4);
  border: none;
  border-bottom: 1px solid var(--rule);
  background: transparent;
  text-align: left;
  cursor: pointer;
  transition: background-color var(--duration-fast) var(--ease-out);
}

.queue__item:hover {
  background: var(--paper-sunk);
}

.queue__item[aria-current='true'] {
  background: var(--accent-wash);
  box-shadow: inset 3px 0 0 var(--accent);
}

.queue__name {
  font-size: var(--text-sm);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.review__work {
  display: grid;
  gap: var(--space-5);
  min-width: 0;
}

.worktop {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--space-5);
  flex-wrap: wrap;
}

.worktop__title {
  font-size: var(--text-lg);
  font-weight: 650;
  letter-spacing: -0.01em;
}

.workgrid {
  display: grid;
  /* The image gets the larger share: it is the source of truth being read. */
  grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr);
  gap: var(--space-5);
  align-items: start;
}

.viewer {
  position: sticky;
  top: 0;
  margin: 0;
  padding: var(--space-3);
  border: 1px solid var(--rule);
  border-radius: var(--radius-panel);
  /* Sunk ground so a white scan reads as a sheet on a surface. */
  background: var(--paper-sunk);
}

.viewer img {
  inline-size: 100%;
  background: var(--paper-raised);
  border: 1px solid var(--rule);
}

.viewer figcaption {
  margin-top: var(--space-3);
}

.fields {
  display: grid;
  gap: var(--space-4);
}

.fieldrow {
  display: grid;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--rule);
  border-radius: var(--radius);
  background: var(--paper-raised);
}

/* The one place a whole row is tinted: a field the model was unsure about,
   not yet touched by a human. That is the work. */
.fieldrow[data-low='true'] {
  border-color: color-mix(in oklch, var(--attention) 40%, transparent);
  background: var(--attention-wash);
}

.fieldrow__label {
  font-size: var(--text-micro);
  font-weight: 600;
  letter-spacing: var(--tracking-caps);
  text-transform: uppercase;
  color: var(--ink-muted);
}

.fieldrow__meta {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  flex-wrap: wrap;
}

.fieldrow__raw {
  font-size: var(--text-micro);
  color: var(--ink-faint);
}

.fieldrow__flag {
  font-size: var(--text-micro);
  letter-spacing: var(--tracking-caps);
  text-transform: uppercase;
  color: var(--ok);
}

.actions {
  position: sticky;
  bottom: 0;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-3);
  padding: var(--space-4) var(--space-5);
  border: 1px solid var(--rule);
  border-radius: var(--radius-panel);
  background: var(--paper-raised);
}

.actions__state {
  margin-right: auto;
  font-size: var(--text-sm);
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

@media (max-width: 68rem) {
  .review,
  .workgrid {
    grid-template-columns: minmax(0, 1fr);
  }

  .review__queue,
  .viewer,
  .actions {
    position: static;
    max-height: none;
  }
}
</style>
