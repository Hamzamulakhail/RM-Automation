# Page Poster

Bulk auto-poster from Google Drive to Facebook Pages with a bilingual (Pashto RTL / English) admin panel, built for **Cloudflare Workers** + **Cloudflare D1** using plain JavaScript ES modules and Web APIs.

---

## Setup & Deployment Steps

### 1. Create a D1 Database
1. Open the **Cloudflare Dashboard** → **Storage & Databases** → **D1 SQL Database** → **Create**.
2. Name it `page-poster-db`.
3. Copy the **Database ID** and replace `REPLACE_WITH_D1_DATABASE_ID` in `wrangler.jsonc`.

*(Database tables and indexes are created automatically on first request or cron run via `CREATE TABLE IF NOT EXISTS`.)*

### 2. Push the Repository to GitHub
Commit and push all files in this repository to a GitHub repository.

### 3. Deploy via Cloudflare Workers Git Integration
1. In the **Cloudflare Dashboard**, go to **Workers & Pages** → **Create** → **Import a repository**.
2. Select your GitHub repository.
3. Make sure the **Worker name** is exactly `page-poster` (matching `"name": "page-poster"` in `wrangler.jsonc`).
4. Deploy command: `npx wrangler deploy` (or `npm run deploy`).

### 4. Configure the 6 Secrets
In Cloudflare Dashboard → **Workers & Pages** → `page-poster` → **Settings** → **Variables and Secrets**, add these **6 Secrets**:

| Secret Name | Value |
|---|---|
| `ADMIN_PASSWORD` | Strong password to log in to the admin panel |
| `SESSION_SECRET` | Random long string (32+ chars) for HMAC session cookies |
| `ENCRYPTION_KEY` | Base64-encoded 32 bytes for AES-256-GCM token encryption (`openssl rand -base64 32`) |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Full JSON contents of your Google Cloud service account key |
| `META_APP_ID` | Your Meta App ID |
| `META_APP_SECRET` | Your Meta App Secret |

### 5. Google Cloud & Google Drive Setup
1. Open **Google Cloud Console**, create/select a project, and enable the **Google Drive API**.
2. Go to **IAM & Admin** → **Service Accounts** → create a service account.
3. Create a **JSON key** for that service account and paste its full JSON into the `GOOGLE_SERVICE_ACCOUNT_JSON` secret.
4. For every Facebook Page:
   - Create two Drive folders (e.g., `Page-Captions` containing `captions.txt`, and `Page-Media` containing numbered `.mp4`/`.mov`/`.jpg`/`.jpeg`/`.png` files like `01-Snowy-Lake.mp4`).
   - Share **both** folders with the service account email (`client_email`) as **Editor** (required so the Worker can update `captions.txt` and move posted media to Trash).

### 6. Meta App Setup
1. Open **Meta for Developers** → create or open your App → add **Facebook Login for Business** (or **Facebook Login**).
2. Under **Facebook Login** → **Settings**, add Valid OAuth Redirect URI:
   ```text
   https://page-poster.<your-subdomain>.workers.dev/auth/facebook/callback
   ```
3. Under **App Settings** → **Basic**, set:
   - **Privacy Policy URL**: `https://page-poster.<your-subdomain>.workers.dev/privacy.html`
   - **User Data Deletion URL**: `https://page-poster.<your-subdomain>.workers.dev/data-deletion.html`
4. While the Meta App is in **Development Mode**, go to **App Roles** → **Roles** and add every Facebook ID (account) you plan to connect — **including any invitees using Invite Links** — as an **Administrator**, **Developer**, or **Tester** (and make sure they accept the role invite in Facebook before opening the Page Poster invite link). Until your Meta App passes App Review and is switched to **Live Mode**, Facebook will block non-Testers with an app-not-active/not-authorized error.

---

## Invite Links (Connecting Someone Else's Facebook ID)

Invite links allow the owner of another Facebook account to log in to Facebook themselves and grant access only to the Pages they pick, without ever getting access to your Page Poster admin panel.

1. Sign in to Page Poster as admin and open **Accounts & Invites**.
2. Under **Create Invite Link**, enter an optional label (e.g. `Maria - PH ID`), choose an expiry (default **48 hours**, max **7 days**), and click **Create invite link**.
3. Copy or share the generated URL (`/invite/<token>`). Only the SHA-256 hash is stored in D1, so the raw link is displayed once at creation.
4. Send the link to the Facebook ID owner:
   - If your Meta App is still in **Development Mode**, add their Facebook account as a **Tester** under **App Roles → Roles** in the Meta App Dashboard first.
   - When they open `/invite/<token>`, they see a clear disclosure of permissions, tick the consent checkbox, click **Continue with Facebook**, authenticate directly with Meta, select at least one Page, and confirm.
   - Their account and selected Pages are stored encrypted (AES-GCM), the invite is immediately marked **Used** (single-use), and their temporary 15-minute `SameSite=Lax` invite cookie grants no access to any other Page Poster route.
5. You can revoke an unused invite at any time from the Invites list (**Revoke**).

---

## Preview vs. Production Cookie Security (`PREVIEW_MODE`)

- **Production (default)**: Leave `PREVIEW_MODE` unset in `wrangler.jsonc` and in Cloudflare dashboard variables. The admin session cookie (`pp_session`) strictly uses `HttpOnly; Secure; SameSite=Strict`.
- **Iframe Preview (`PREVIEW_MODE="1"`)**: Only when running inside an embedded cross-site preview iframe (such as AI Studio preview via `.dev.vars`), set `PREVIEW_MODE="1"`. Only this explicit environment variable switches `pp_session` to `SameSite=None; Secure; Partitioned`. Request headers (`Origin`, `Referer`, `X-Forwarded-*`) are never used to relax cookie flags. **Do not set `PREVIEW_MODE="1"` in production.**

---

## Test Checklist
- [ ] Open `https://page-poster.<your-subdomain>.workers.dev` and sign in with `ADMIN_PASSWORD`.
- [ ] Toggle language between Pashto (RTL) and English (LTR) and test Light/Dark theme switching.
- [ ] Go to **Accounts & Invites** → click **Connect Facebook ID (OAuth)** (or create an **Invite link** for another Facebook owner) and select Page(s).
- [ ] Click a Page card on the **Dashboard** to open the Page Details drawer, verify the service-account email is shown under **Drive Folders**, load shared folders, and link the Captions and Media folders (confirm no view-only warning appears).
- [ ] Configure slots, timezone, jitter, daily cap, min gap under **Schedule**, and save.
- [ ] Open the **Queue Preview** tab (or click **Preview** on the card) and verify the smallest matching pair and orphan warnings display accurately without posting.
- [ ] Click **Post now** on a test Page with a small image/video; confirm it appears on Facebook, its block is removed from `captions.txt`, and the media file is moved to Google Drive Trash.
- [ ] Wait 1–2 minutes and check the **Activity Logs** tab to confirm the `* * * * *` cron trigger is executing cleanly.

---

## Design System ("Aurora Control Center")

The UI uses pure CSS custom properties and vanilla ES modules (`public/style.css`, `public/js/*`) with zero build steps or external fonts/CDNs.

- **Tokens (`public/style.css` `:root`)**:
  - **Surfaces & Ink**: Deep ink (`--bg: #0a0e1a`), 3 elevation levels (`--surface-1`, `--surface-2`, `--surface-3`), 1px hairline borders (`--border`, `--border-strong`) with inner highlights (`--inner-hi`), and light mode overrides (`:root[data-theme="light"]` + `prefers-color-scheme: light` when `system`).
  - **Scales**: 4pt spacing (`--sp-1` .. `--sp-12`), radii (`--r-sm: 10px` to `--r-xl: 28px`), layered shadows (`--sh-sm/md/lg`), z-index layers (`--z-sticky` .. `--z-toast`), durations (`120/200/320ms`), and fluid `clamp()` typography with RTL Pashto stack (`--font-rtl`).
  - **Semantic Status Colors**: `--emerald` (active/posted), `--amber` (pending/paused/warn), `--rose` (failed/needs attention), `--sky` (info), `--violet` (posting now).
- **Components (`public/js/components.js`)**:
  - Collapsible desktop icon-rail sidebar, sticky glass topbar, mobile safe-area bottom nav with central Quick Actions sheet, `Ctrl/Cmd+K` Command Palette, Hero Today progress ring + 7-day inline SVG sparkline KPI tiles, container-query Page cards with interactive 24-hour timeline strips, right-side / mobile-sheet Page Drawer (visual 24h jitter bar, chips, steppers, live summary), 3-step Invite lifecycle tracker, and responsive tables-to-cards.
- **Changing the Accent**:
  - Users can pick from 5 presets in **Settings → Accent Preset** (`aurora`, `violet`, `emerald`, `amber`, `rose`, persisted in `localStorage` under `pp_accent`).
  - To change the default gradient in code, update `--accent-1`, `--accent-2`, `--accent-soft`, and `--accent-glow` inside `:root` in `public/style.css` (and the inline SVG `<linearGradient>` in `public/index.html` for the favicon).

---

## Limitations (Cloudflare Workers Free Plan)
- **128 MB Isolate Memory Limit vs. 100 MB Media Limit**: Standard `FormData` + `Blob` uploads to Facebook Graph API buffer the downloaded media file in Worker memory. Cloudflare Workers isolates have a hard **128 MB RAM limit**. Although the code enforces the **100 MB** ceiling before downloading, large video files above ~50–60 MB can trigger a `Worker exceeded memory limit` error depending on V8 heap overhead. For reliable posting on the Free plan, keep videos under **~50 MB** (or move to a larger video pipeline / Paid plan if regularly posting 60–100 MB videos).
- **10 ms CPU Time Limit per Invocation**: Workers Free allows 10 ms of active JS CPU execution per request/cron run (network I/O wait time does not count). The Google Drive access token is cached in D1 for 50 minutes to avoid re-signing RS256 JWTs on every cron tick.
- **50 D1 Queries & 50 Fetch Subrequests per Invocation**: Each cron run uses batched D1 queries (typically 6–18 queries) and caps publishing at `MAX_POSTS_PER_RUN` (`3`) so subrequests stay safely under the 50-subrequest limit. If you manage dozens of Pages, some Pages will be served on the next minute's cron tick via round-robin shuffling.
