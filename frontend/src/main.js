import { createApp } from 'vue'
import { createPinia } from 'pinia'

import App from './App.vue'
import router from './router'
import './styles/global.css'

const app = createApp(App)

/**
 * Last-resort handler for anything a component did not catch. Logged to the
 * console rather than posted to the server, because a skeleton should not
 * quietly ship telemetry — wire it to your own error sink when you have one.
 */
app.config.errorHandler = (error, _instance, info) => {
  console.error('[unhandled]', info, error)
}

app.use(createPinia()).use(router).mount('#app')
