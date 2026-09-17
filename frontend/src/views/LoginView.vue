<script setup>
import { ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { useAuthStore } from '../stores/auth'

const auth = useAuthStore()
const route = useRoute()
const router = useRouter()

const username = ref('')
const password = ref('')
const error = ref('')
const submitting = ref(false)

async function submit() {
  error.value = ''
  submitting.value = true
  try {
    await auth.login(username.value, password.value)
    // Honour ?redirect so a session that expired mid-task returns the user to
    // where they were, not to the dashboard.
    const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : '/'
    await router.push(redirect)
  } catch (requestError) {
    error.value = requestError.userMessage ?? 'Sign-in failed.'
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <!-- Asymmetric split rather than a centred card on a gradient: the dark
       panel carries the identity, the light side carries the one task. -->
  <div class="login">
    <aside class="login__aside">
      <div class="login__brand">
        <span class="login__mark" aria-hidden="true"></span>
        <span>Review Workbench</span>
      </div>
      <p class="login__blurb">Batch document review and reconciliation.</p>
      <p class="login__foot eyebrow">Internal tool · authorised users only</p>
    </aside>

    <main class="login__main">
      <form class="login__form" @submit.prevent="submit">
        <div>
          <p class="eyebrow">Sign in</p>
          <h1 class="login__title">Welcome back</h1>
        </div>

        <div class="field">
          <label for="username">Username</label>
          <input
            id="username"
            v-model="username"
            class="input"
            name="username"
            autocomplete="username"
            required
            autofocus
          />
        </div>

        <div class="field">
          <label for="password">Password</label>
          <input
            id="password"
            v-model="password"
            class="input"
            type="password"
            name="password"
            autocomplete="current-password"
            required
          />
        </div>

        <!-- role="alert" so the failure is announced, not only shown. -->
        <p v-if="error" class="login__error" role="alert">{{ error }}</p>

        <button class="btn btn--primary login__submit" type="submit" :disabled="submitting">
          {{ submitting ? 'Signing in…' : 'Sign in' }}
        </button>
      </form>
    </main>
  </div>
</template>

<style scoped>
.login {
  display: grid;
  grid-template-columns: minmax(0, 22rem) minmax(0, 1fr);
  min-height: 100%;
}

.login__aside {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  gap: var(--space-7);
  padding: var(--space-7) var(--space-6);
  background: var(--paper-inverted);
  color: var(--ink-inverted);
  /* Faint grain so the dark panel is a surface rather than a flat fill.
     Pure CSS — no image request. */
  background-image: repeating-linear-gradient(
    45deg,
    color-mix(in oklch, var(--ink-inverted) 3%, transparent) 0 1px,
    transparent 1px 4px
  );
}

.login__brand {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  font-size: var(--text-sm);
  font-weight: 600;
}

.login__mark {
  width: 0.875rem;
  height: 0.875rem;
  background: var(--attention);
  clip-path: polygon(0 0, 100% 0, 100% 65%, 65% 100%, 0 100%);
}

.login__blurb {
  max-width: 22ch;
  font-size: var(--text-lg);
  line-height: var(--leading-tight);
  color: color-mix(in oklch, var(--ink-inverted) 78%, transparent);
}

.login__foot {
  color: color-mix(in oklch, var(--ink-inverted) 45%, transparent);
}

.login__main {
  display: grid;
  place-items: center;
  padding: var(--space-6);
}

.login__form {
  display: grid;
  gap: var(--space-5);
  width: 100%;
  max-width: 21rem;
}

/* The one large type size in the app. Scale contrast against --text-base is
   what makes this read as a title without a decorative treatment. */
.login__title {
  font-size: var(--text-display);
  font-weight: 650;
  line-height: var(--leading-tight);
  letter-spacing: -0.02em;
}

.login__error {
  padding: var(--space-3) var(--space-4);
  border-left: 2px solid var(--danger);
  background: var(--danger-wash);
  font-size: var(--text-sm);
}

.login__submit {
  justify-content: center;
  padding: var(--space-3) var(--space-5);
}

@media (max-width: 46rem) {
  .login {
    grid-template-columns: minmax(0, 1fr);
  }

  .login__aside {
    gap: var(--space-4);
    padding: var(--space-5);
  }

  .login__blurb {
    display: none;
  }
}
</style>
