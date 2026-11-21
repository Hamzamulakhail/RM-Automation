let schemaPromise = null;

export function ensureSchema(db) {
  if (!schemaPromise) {
    schemaPromise = initSchema(db).catch((err) => {
      schemaPromise = null;
      throw err;
    });
  }
  return schemaPromise;
}

async function initSchema(db) {
  const statements = [
    `CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fb_user_id TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      encrypted_token TEXT NOT NULL,
      token_expires_at TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS pages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      fb_page_id TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      encrypted_page_token TEXT NOT NULL,
      captions_folder_id TEXT NOT NULL DEFAULT '',
      captions_folder_name TEXT NOT NULL DEFAULT '',
      media_folder_id TEXT NOT NULL DEFAULT '',
      media_folder_name TEXT NOT NULL DEFAULT '',
      timezone TEXT NOT NULL DEFAULT 'America/New_York',
      slots TEXT NOT NULL DEFAULT '["08:00","10:00","12:00","14:00","19:00","21:00"]',
      jitter_minutes INTEGER NOT NULL DEFAULT 20,
      daily_cap INTEGER NOT NULL DEFAULT 6,
      min_gap_minutes INTEGER NOT NULL DEFAULT 60,
      ramp_up_enabled INTEGER NOT NULL DEFAULT 0,
      ramp_start INTEGER NOT NULL DEFAULT 2,
      ramp_step_days INTEGER NOT NULL DEFAULT 3,
      status TEXT NOT NULL DEFAULT 'active',
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS plan (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      page_id INTEGER NOT NULL,
      local_date TEXT NOT NULL,
      slot_time TEXT NOT NULL,
      planned_local TEXT NOT NULL,
      planned_utc TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_utc TEXT,
      fb_post_id TEXT,
      file_id TEXT,
      file_name TEXT,
      caption_number INTEGER,
      caption_text TEXT,
      error TEXT,
      claimed_at TEXT,
      finished_at TEXT,
      cleanup_pending INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS blocked_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      page_id INTEGER NOT NULL,
      file_id TEXT NOT NULL,
      file_name TEXT NOT NULL,
      reason TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      UNIQUE(page_id, file_id),
      FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      page_id INTEGER,
      level TEXT NOT NULL DEFAULT 'info',
      event_type TEXT NOT NULL,
      message TEXT NOT NULL,
      details TEXT,
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS login_attempts (
      ip TEXT PRIMARY KEY,
      failures INTEGER NOT NULL DEFAULT 0,
      locked_until TEXT,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS cached_tokens (
      cache_key TEXT PRIMARY KEY,
      token TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS licenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key_hash TEXT NOT NULL UNIQUE,
      key_prefix TEXT NOT NULL DEFAULT '',
      label TEXT NOT NULL DEFAULT '',
      max_pages INTEGER NOT NULL DEFAULT 20,
      status TEXT NOT NULL DEFAULT 'active',
      expires_at TEXT,
      global_pause INTEGER NOT NULL DEFAULT 0,
      google_email TEXT,
      google_encrypted_refresh_token TEXT,
      google_connected_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS invites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_hash TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      revoked_at TEXT,
      account_id INTEGER,
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE SET NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_pages_status ON pages(status)`,
    `CREATE INDEX IF NOT EXISTS idx_plan_page_date ON plan(page_id, local_date)`,
    `CREATE INDEX IF NOT EXISTS idx_plan_status_utc ON plan(status, planned_utc)`,
    `CREATE INDEX IF NOT EXISTS idx_plan_cleanup ON plan(cleanup_pending)`,
    `CREATE INDEX IF NOT EXISTS idx_blocked_page ON blocked_files(page_id)`,
    `CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at, page_id, level)`,
    `CREATE INDEX IF NOT EXISTS idx_invites_hash ON invites(token_hash)`,
    `CREATE INDEX IF NOT EXISTS idx_licenses_hash ON licenses(key_hash)`,
    `INSERT OR IGNORE INTO settings (key, value) VALUES ('global_pause', '0')`,
  ];

  await db.batch(statements.map((sql) => db.prepare(sql)));

  // Guarded additive column migrations for existing deployments
  const [accCols, pageCols, eventCols] = await db.batch([
    db.prepare(`PRAGMA table_info(accounts)`),
    db.prepare(`PRAGMA table_info(pages)`),
    db.prepare(`PRAGMA table_info(events)`),
  ]);

  const alterStmts = [];
  const hasCol = (res, name) => (res.results || []).some((r) => r.name === name);

  if (!hasCol(accCols, 'license_id')) {
    alterStmts.push(`ALTER TABLE accounts ADD COLUMN license_id INTEGER`);
  }
  if (!hasCol(accCols, 'token_kind')) {
    alterStmts.push(`ALTER TABLE accounts ADD COLUMN token_kind TEXT NOT NULL DEFAULT 'user'`);
  }
  if (!hasCol(pageCols, 'license_id')) {
    alterStmts.push(`ALTER TABLE pages ADD COLUMN license_id INTEGER`);
  }
  if (!hasCol(pageCols, 'picture_url')) {
    alterStmts.push(`ALTER TABLE pages ADD COLUMN picture_url TEXT`);
  }
  if (!hasCol(pageCols, 'last_drive_sync_at')) {
    alterStmts.push(`ALTER TABLE pages ADD COLUMN last_drive_sync_at TEXT`);
  }
  if (!hasCol(pageCols, 'last_drive_sync_error')) {
    alterStmts.push(`ALTER TABLE pages ADD COLUMN last_drive_sync_error TEXT`);
  }
  if (!hasCol(eventCols, 'license_id')) {
    alterStmts.push(`ALTER TABLE events ADD COLUMN license_id INTEGER`);
  }

  for (const sql of alterStmts) {
    try {
      await db.prepare(sql).run();
    } catch {
      // Ignore duplicate column race across concurrent isolates
    }
  }

  await db.batch([
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_accounts_license ON accounts(license_id)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_pages_license ON pages(license_id)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_events_license ON events(license_id)`),
  ]);
}

export function prepareEventStmt(db, { pageId = null, licenseId = null, level = 'info', eventType, message, details = null, createdAt = new Date().toISOString() }) {
  const detailsStr = details == null ? null : (typeof details === 'string' ? details : JSON.stringify(details));
  return db
    .prepare(
      `INSERT INTO events (page_id, license_id, level, event_type, message, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(pageId, licenseId, level, eventType, String(message).slice(0, 1000), detailsStr ? detailsStr.slice(0, 4000) : null, createdAt);
}

export async function logEvent(db, payload) {
  await prepareEventStmt(db, payload).run();
}
