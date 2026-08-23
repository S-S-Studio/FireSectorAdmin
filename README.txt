FireSector Admin PWA v007

Major changes:
- No esm.sh / external Supabase JavaScript SDK dependency.
- Direct Supabase Auth and REST calls with the browser-safe publishable key.
- No persistent auth session. Every page load or PWA launch starts locked.
- Startup timeout with Retry screen instead of endless Loading.
- Service worker updated to prefer fresh app.js/styles/index and remove old caches.
- Temporary Access is now the primary dashboard focus on desktop and mobile.
- Other admin tools are visually secondary.

Deploy:
Replace ALL files in the existing GitHub Pages repository with this v004 package.
Commit/push and wait for GitHub Pages deployment to complete.

If the already-installed PWA still shows an old version once:
1. Open the website in the browser.
2. Refresh it once after GitHub Pages finishes deploying.
3. Reopen the installed PWA.
The v004 service worker will remove older FireSector Admin caches.

V005:
- Temporary Access remains the primary dashboard function.
- Removed website-style explanatory descriptions.
- Renamed Markers to Map Data.
- Renamed District Data to Districts.
- System Status retained.
- Secondary administration cards now use concise app-style labels.

V006:
- Persistent custom eye icon for show/hide password.
- Eye control remains visible after failed sign-in attempts.
- Failed sign-in shows: Incorrect email or password.
- Failed login does not clear the entered password.
- Stronger browser autofill styling keeps input fields white.
- Login error clears when the user edits email or password.

V007:
- Removed backend connectivity status from the normal dashboard.
- Uses Area as the FireSector operational term instead of District in UI labels.
- Districts admin tile renamed Areas.
- District access renamed Area access.
- System Status removed from the normal dashboard.
