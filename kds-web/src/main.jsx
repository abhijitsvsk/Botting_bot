import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import * as Sentry from '@sentry/react'
import { supabase } from './supabase'
import './index.css'
import App from './App.jsx'

if (import.meta.env.VITE_SENTRY_DSN) {
  Sentry.init({
    dsn: import.meta.env.VITE_SENTRY_DSN,
    integrations: [Sentry.browserTracingIntegration()],
    tracesSampleRate: 1.0, 
  });

  supabase.auth.onAuthStateChange((event, session) => {
    if (session?.user) {
      // Decode JWT safely if possible or just use user id
      Sentry.setUser({ id: session.user.id });
      // Tag restaurant id if available in app_metadata
      const restaurant_id = session.user.app_metadata?.restaurant_id || null;
      if (restaurant_id) {
        Sentry.setTag("restaurant_id", restaurant_id);
      }
    } else {
      Sentry.setUser(null);
      Sentry.setTag("restaurant_id", null);
    }
  });

  // Check initial session
  supabase.auth.getSession().then(({ data: { session } }) => {
    if (session?.user) {
      Sentry.setUser({ id: session.user.id });
      const restaurant_id = session.user.app_metadata?.restaurant_id || null;
      if (restaurant_id) {
        Sentry.setTag("restaurant_id", restaurant_id);
      }
    }
  });
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
