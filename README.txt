FireSector Admin PWA v003
Deploy all files to any HTTPS static host.
Includes Supabase login, active-admin validation, Super Admin detection, district loading, Petrusburg preference, responsive app-style layout and installable PWA support.
The publishable key in app.js is intentionally browser-safe. Never add a secret/service_role key to this project.

V002: Persistent Show/Hide password control and autofill field highlight cleanup.

V003:
- Supabase sessions are no longer persisted.
- Refresh, browser reopen or PWA reopen always returns to the login screen.
- Existing V002 password visibility and input/autofill fixes retained.
