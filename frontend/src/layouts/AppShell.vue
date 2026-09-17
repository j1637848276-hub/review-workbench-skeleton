<script setup>
import { computed, onMounted, ref } from 'vue'
import { RouterLink, RouterView, useRouter } from 'vue-router'

import { useAuthStore } from '../stores/auth'

const auth = useAuthStore()
const router = useRouter()

/**
 * Theme is stored locally and applied to <html>, not driven by
 * prefers-color-scheme. Operators work next to paper documents under
 * fluorescent light, so matching the paper is the sensible default and dark is
 * a deliberate choice.
 */
const theme = ref(localStorage.getItem('workbench:theme') ?? 'light')

function applyTheme(next) {
  theme.value = next
  document.documentElement.dataset.theme = next
  localStorage.setItem('workbench:theme', next)
}

onMounted(() => applyTheme(theme.value))

const nav = computed(() =>
  [
    { to: { name: 'dashboard' }, label: 'Batches', shown: true },
    { to: { name: 'review' }, label: 'Review queue', shown: auth.can('reviewer') },
    { to: { name: 'audit' }, label: 'Audit log', shown: auth.role === 'admin' },
  ].filter((item) => item.shown)
)

async function signOut() {
  await auth.logout()
  router.push({ name: 'login' })
}
</script>

<template>
  <div class="shell">
    <!-- Skip link: the first tab stop on every page, so a keyboard user is not
         forced through the whole sidebar to reach the table. -->
    <a class="skip" href="#main">Skip to content</a>

    <header class="shell__bar">
      <div class="brand">
        <span class="brand__mark" aria-hidden="true"></span>
        <span class="brand__name">Review Workbench</span>
      </div>

      <div class="row">
        <button
          class="btn btn--ghost btn--sm"
          type="button"
          :aria-pressed="theme === 'dark'"
          @click="applyTheme(theme === 'dark' ? 'light' : 'dark')"
        >
          {{ theme === 'dark' ? 'Light' : 'Dark' }}
        </button>

        <span class="whoami">
          <span class="num">{{ auth.user?.username }}</span>
          <span class="whoami__role">{{ auth.role }}</span>
        </span>

        <button class="btn btn--ghost btn--sm" type="button" @click="signOut">Sign out</button>
      </div>
    </header>

    <div class="shell__body">
      <nav class="shell__nav" aria-label="Sections">
        <RouterLink
          v-for="item in nav"
          :key="item.label"
          :to="item.to"
          class="navlink"
          active-class="navlink--active"
        >
          {{ item.label }}
        </RouterLink>
      </nav>

      <main id="main" class="shell__main">
        <RouterView />
      </main>
    </div>
  </div>
</template>

<style scoped>
.shell {
  display: grid;
  grid-template-rows: auto 1fr;
  height: 100%;
}

.skip {
  position: absolute;
  left: var(--space-3);
  top: -3rem;
  z-index: 100;
  padding: var(--space-2) var(--space-4);
  background: var(--paper-raised);
  border: 1px solid var(--accent);
  border-radius: var(--radius);
  transition: top var(--duration) var(--ease-out);
}

.skip:focus {
  top: var(--space-3);
}

/* Inverted bar. This is where the layering comes from — a dark band against
 * paper reads as depth without a single shadow. */
.shell__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-5);
  padding: var(--space-3) var(--space-5);
  background: var(--paper-inverted);
  color: var(--ink-inverted);
}

.brand {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

/* A drawn mark rather than an icon font or an SVG file: no request, no
 * dependency, and it is unmistakably this app. */
.brand__mark {
  width: 0.875rem;
  height: 0.875rem;
  background: var(--attention);
  /* Deliberately off-square — a notched corner, not a rounded rectangle. */
  clip-path: polygon(0 0, 100% 0, 100% 65%, 65% 100%, 0 100%);
}

.brand__name {
  font-size: var(--text-sm);
  font-weight: 600;
  letter-spacing: 0.01em;
}

.whoami {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  font-size: var(--text-sm);
}

.whoami__role {
  font-size: var(--text-micro);
  letter-spacing: var(--tracking-caps);
  text-transform: uppercase;
  color: color-mix(in oklch, var(--ink-inverted) 60%, transparent);
}

.shell__bar .btn--ghost {
  color: color-mix(in oklch, var(--ink-inverted) 80%, transparent);
}

.shell__bar .btn--ghost:hover {
  background: color-mix(in oklch, var(--ink-inverted) 12%, transparent);
  color: var(--ink-inverted);
}

.shell__body {
  display: grid;
  grid-template-columns: var(--sidebar-width) minmax(0, 1fr);
  min-height: 0;
}

.shell__nav {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: var(--space-5) var(--space-3);
  border-right: 1px solid var(--rule);
  background: var(--paper-sunk);
}

.navlink {
  padding: var(--space-3) var(--space-4);
  border-radius: var(--radius);
  color: var(--ink-muted);
  font-size: var(--text-sm);
  text-decoration: none;
  transition:
    background-color var(--duration-fast) var(--ease-out),
    color var(--duration-fast) var(--ease-out);
}

.navlink:hover {
  background: var(--paper-raised);
  color: var(--ink);
}

/* Inset bar marks the active section. An outline border would shift the text. */
.navlink--active {
  background: var(--paper-raised);
  color: var(--ink);
  font-weight: 600;
  box-shadow: inset 3px 0 0 var(--accent);
}

.shell__main {
  min-width: 0;
  padding: var(--space-6) var(--space-6) var(--space-8);
  overflow-y: auto;
}

/* Single breakpoint: the sidebar becomes a horizontal strip. An internal tool
 * used on laptops and desktops does not need five. */
@media (max-width: 52rem) {
  .shell__body {
    grid-template-columns: minmax(0, 1fr);
  }

  .shell__nav {
    flex-direction: row;
    overflow-x: auto;
    border-right: none;
    border-bottom: 1px solid var(--rule);
    padding: var(--space-2) var(--space-3);
  }

  .navlink--active {
    box-shadow: inset 0 -3px 0 var(--accent);
  }

  .shell__main {
    padding: var(--space-5) var(--space-4) var(--space-7);
  }
}
</style>
