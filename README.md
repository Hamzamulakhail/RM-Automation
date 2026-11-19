# RM Automation

Multi-tenant bulk auto-poster from Google Drive to Facebook Pages with a bilingual (Pashto RTL / English) control center, built for **Cloudflare Workers** + **Cloudflare D1** using plain JavaScript ES modules and Web APIs.

---

## Architecture Highlights

- **Super Admin + Customer License Keys**:
  - Owner signs in with `ADMIN_PASSWORD` as **Super Admin** to manage their own private workspace (`license_id IS NULL`) and generate isolated **License Keys** (`RM-XXXX-XXXX-XXXX-XXXX`) for customers under the **Licenses** tab (with custom label, `max_pages` cap, expiry, active/disabled toggle, `+30d` extend, and cascade delete).
  - Customers sign in using their License Key into an isolated workspace where their Google Drive, Facebook Pages, schedules, and logs are strictly separated from every other customer and the owner.
- **Per-User Sign in with Google (Google Drive OAuth 2.0)**:
  - Each user connects their own Google Drive with one click (**Sign in with Google** → `/auth/google/start` → `/auth/google/callback`).
  - The refresh token is encrypted at rest (`AES-256-GCM`) in D1 and auto-refreshes access tokens automatically.
  - Super Admin also retains optional `GOOGLE_SERVICE_ACCOUNT_JSON` fallback if preferred.
- **2 Simple Facebook Token-Paste Modes (No FB OAuth / No Invite Links)**:
  1. **Account Token (All Pages)**: Paste a Meta User Access Token to verify identity, fetch `/me/accounts`, and pick Pages to connect.
  2. **Single Page Token**: Paste a direct Page Access Token to verify and connect a single Page in one step.

---

## Setup & Deployment Steps

### 1. D1 Database (`page-poster-db`)
`wrangler.jsonc` binds `"DB"` to `"database_name": "page-poster-db"`:
- Wrangler 4 automatically connects to an existing D1 database named `page-poster-db` or provisions it on deploy (or inherits an existing `DB` binding in Worker **Settings → Bindings**).
- Additive schema tables (`licenses`, `accounts`, `pages`, `daily_plan`, `blocked_files`, `events`, `settings`, `cached_tokens`) and indexes are created automatically via guarded migrations.

### 2. Push to GitHub & Auto-Deploy on Cloudflare Workers
Commit and push changes to `main`. Cloudflare Workers Git Integration automatically deploys updates to `https://mulakhail.rmautomation.workers.dev/`.

### 3. Configure Secrets in Cloudflare Dashboard
In Cloudflare Dashboard → **Workers & Pages** → `rm-automation` → **Settings** → **Variables and Secrets**, configure:

| Secret Name | Required | Value |
|---|---|---|
| `ADMIN_PASSWORD` | Yes | Super Admin password (never share with customers) |
| `SESSION_SECRET` | Yes | Random long string (32+ chars) for HMAC session & Google OAuth state cookies |
| `ENCRYPTION_KEY` | Yes | Base64-encoded 32 bytes for AES-256-GCM token encryption (`openssl rand -base64 32`) |
| `GOOGLE_CLIENT_ID` | Yes | Google Cloud OAuth 2.0 Web Client ID |
| `GOOGLE_CLIENT_SECRET` | Yes | Google Cloud OAuth 2.0 Web Client Secret |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Optional | Optional fallback Service Account JSON for Super Admin only |

*(Note: `META_APP_ID` / `META_APP_SECRET` are no longer required because Facebook OAuth login was removed in favor of simple token pasting.)*

### 4. Google Cloud OAuth 2.0 Setup (So Google Logins Never Expire)
1. Open **Google Cloud Console** → select or create a project → **APIs & Services** → **Library** → enable **Google Drive API**.
2. Go to **Google Auth Platform** (or **OAuth consent screen**) → choose **External** → fill in App name (`RM Automation`), support email, Privacy Policy (`https://mulakhail.rmautomation.workers.dev/privacy.html`), and developer contact email.
3. Add scopes:
   - `https://www.googleapis.com/auth/drive`
   - `https://www.googleapis.com/auth/userinfo.email`
4. **CRITICAL — Publish App to Production**:
   - Under **Audience** / **OAuth consent screen**, click **Publish App** (move from **Testing** to **In Production**).
   - While in *Testing* mode, Google forces refresh tokens to expire every **7 days**; in **Production** mode, refresh tokens remain valid indefinitely until the user revokes access.
5. Go to **Clients** (or **Credentials**) → **Create OAuth client ID** → **Web application**:
   - **Authorized redirect URI**:
     ```text
     https://mulakhail.rmautomation.workers.dev/auth/google/callback
     ```
6. Copy the **Client ID** and **Client Secret** into Cloudflare Secrets `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

---

## Preview vs. Production Cookie Security (`PREVIEW_MODE`)

- **Production (default)**: Leave `PREVIEW_MODE` unset in `wrangler.jsonc` and Cloudflare Dashboard. `pp_session` uses `HttpOnly; Secure; SameSite=Strict`. (`/auth/google/callback` validates an HMAC-signed `state` token matched with a short-lived `SameSite=Lax` `pp_google_state` cookie so cross-site Google redirects work cleanly without relaxing `pp_session`.)
- **Iframe Preview (`PREVIEW_MODE="1"`)**: Only when running inside an embedded preview iframe (via `.dev.vars`), set `PREVIEW_MODE="1"`. **Do not set `PREVIEW_MODE="1"` in production.**

---

## Limitations (Cloudflare Workers Free Plan)
- **128 MB Isolate Memory Limit**: Keep uploaded videos under **~50 MB** for reliable posting on the Free plan.
- **50 D1 Queries & 50 Fetch Subrequests per Invocation**: Each cron run caps publishing at `MAX_POSTS_PER_RUN` (`3`) via round-robin shuffling across runnable active pages (skipping disabled/expired licenses and globally paused workspaces).
