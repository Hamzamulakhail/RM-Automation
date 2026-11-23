import { decryptText } from './crypto.js';
import { prepareEventStmt } from './db.js';
import {
  downloadMediaBlob,
  downloadTextFile,
  findCaptionsFile,
  listMediaFiles,
  trashFile,
  updateTextFile,
} from './drive.js';
import {
  classifyFacebookError,
  fetchRecentPagePosts,
  postPhotoToPage,
  postVideoToPage,
} from './facebook.js';
import { removeCaptionBlock, selectNextPair, selectPairsOrdered } from './pairing.js';
import {
  dateDiffDays,
  getLocalParts,
  localDateTimeToUtcMs,
  minutesToHHMM,
  parseSlotMinutes,
} from './timezone.js';

const BACKOFF_MINUTES = [2, 10, 30, 120, 360];
const MAX_ATTEMPTS = 5;
const LATE_CUTOFF_MS = 90 * 60_000;
const PAST_SKIP_MS = 30 * 60_000;
const STUCK_POSTING_MS = 10 * 60_000;

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function computeEffectiveDailyCap(page, localDateStr) {
  const dailyCap = Math.max(1, Number(page.daily_cap || 6));
  if (!page.ramp_up_enabled) return dailyCap;

  const createdLocalDate = getLocalParts(new Date(page.created_at), page.timezone).localDate;
  const daysSince = Math.max(0, dateDiffDays(createdLocalDate, localDateStr));
  const rampStart = Math.max(1, Number(page.ramp_start || 2));
  const rampStep = Math.max(1, Number(page.ramp_step_days || 3));
  const rampCap = rampStart + Math.floor(daysSince / rampStep);
  return Math.min(dailyCap, rampCap);
}

export function buildPlanRowsForPage(page, localDateStr, nowMs, existingAcceptedUtcMs = []) {
  let rawSlots = [];
  try {
    rawSlots = JSON.parse(page.slots || '[]');
  } catch {
    rawSlots = [];
  }
  if (!Array.isArray(rawSlots)) rawSlots = [];

  const parsedSlots = [];
  for (const s of rawSlots) {
    const mins = parseSlotMinutes(String(s));
    if (mins !== null) parsedSlots.push({ slotTime: minutesToHHMM(mins), mins });
  }
  parsedSlots.sort((a, b) => a.mins - b.mins);

  const effectiveCap = computeEffectiveDailyCap(page, localDateStr);
  const chosen = parsedSlots.slice(0, effectiveCap);

  const jitter = Math.max(0, Number(page.jitter_minutes || 0));
  const minGapMs = Math.max(0, Number(page.min_gap_minutes || 0)) * 60_000;

  const candidates = chosen.map((c) => {
    const offset = jitter > 0 ? Math.floor(Math.random() * (2 * jitter + 1)) - jitter : 0;
    const plannedMins = Math.max(0, Math.min(1439, c.mins + offset));
    const plannedLocal = minutesToHHMM(plannedMins);
    const plannedUtcMs = localDateTimeToUtcMs(localDateStr, plannedMins, page.timezone);
    return {
      page_id: page.id,
      local_date: localDateStr,
      slot_time: c.slotTime,
      planned_local: plannedLocal,
      planned_utc: new Date(plannedUtcMs).toISOString(),
      plannedUtcMs,
    };
  });

  candidates.sort((a, b) => a.plannedUtcMs - b.plannedUtcMs);

  let lastAcceptedMs = existingAcceptedUtcMs.length > 0 ? Math.max(...existingAcceptedUtcMs) : null;
  const rows = [];

  for (const item of candidates) {
    if (item.plannedUtcMs < nowMs - PAST_SKIP_MS) {
      rows.push({
        ...item,
        status: 'skipped',
        error: 'Skipped: slot >30 min in the past at plan generation',
        finished_at: new Date(nowMs).toISOString(),
      });
      continue;
    }
    if (lastAcceptedMs !== null && item.plannedUtcMs - lastAcceptedMs < minGapMs) {
      rows.push({
        ...item,
        status: 'skipped',
        error: `Skipped: min gap (${page.min_gap_minutes}m) constraint`,
        finished_at: new Date(nowMs).toISOString(),
      });
      continue;
    }
    lastAcceptedMs = item.plannedUtcMs;
    rows.push({
      ...item,
      status: 'pending',
      error: null,
      finished_at: null,
    });
  }

  return rows;
}

async function insertPlanRowsBatch(db, rows) {
  if (!rows || rows.length === 0) return;
  const chunkSize = 10; // 10 rows * 9 params = 90 bindings (under D1 100-param limit per query)
  const stmts = [];
  for (let i = 0; i < rows.length; i += chunkSize) {
    const slice = rows.slice(i, i + chunkSize);
    const placeholders = slice.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
    const params = [];
    for (const r of slice) {
      params.push(
        r.page_id,
        r.local_date,
        r.slot_time,
        r.planned_local,
        r.planned_utc,
        r.status,
        r.error,
        r.finished_at,
        0
      );
    }
    stmts.push(
      db
        .prepare(
          `INSERT INTO plan (page_id, local_date, slot_time, planned_local, planned_utc, status, error, finished_at, cleanup_pending)
           VALUES ${placeholders}`
        )
        .bind(...params)
    );
  }
  await db.batch(stmts);
}

export async function regenerateTodayPlanForPage(env, page, oldLocalDate = null) {
  const nowMs = Date.now();
  const localDateStr = getLocalParts(nowMs, page.timezone).localDate;
  const staleCutoffUtc = new Date(nowMs - 36 * 3600_000).toISOString();

  const existing = await env.DB.prepare(
    `SELECT id, status, planned_utc FROM plan WHERE page_id = ? AND local_date = ?`
  )
    .bind(page.id, localDateStr)
    .all();

  const keepTimes = [];
  for (const r of existing.results || []) {
    if (r.status === 'posted' || r.status === 'posting') {
      keepTimes.push(Date.parse(r.planned_utc));
    }
  }

  // Delete unattempted pending/skipped rows for current date, previous timezone date, or recent horizon
  const oldDateMatch = oldLocalDate || localDateStr;
  await env.DB.prepare(
    `DELETE FROM plan
     WHERE page_id = ?
       AND status IN ('pending', 'skipped')
       AND attempts = 0
       AND (local_date = ? OR local_date = ? OR planned_utc >= ?)`
  )
    .bind(page.id, localDateStr, oldDateMatch, staleCutoffUtc)
    .run();

  const newRows = buildPlanRowsForPage(page, localDateStr, nowMs, keepTimes);
  // Avoid duplicating already-kept slots if regenerating same day after some posted
  const filtered = newRows.filter(
    (r) => !keepTimes.some((t) => Math.abs(t - r.plannedUtcMs) < 15 * 60_000)
  );
  await insertPlanRowsBatch(env.DB, filtered);
}

async function loadDriveInputsForPage(
  env,
  page,
  blockedFileIds,
  { excludeFileIds = new Set(), excludeCaptionNumbers = new Set(), limit = 50 } = {}
) {
  if (!page.captions_folder_id || !page.media_folder_id) {
    const err = new Error('Google Drive captions or media folder is not configured');
    err.isConfigError = true;
    throw err;
  }

  const licenseId = page.license_id ?? null;
  const [captionsFile, mediaFiles] = await Promise.all([
    findCaptionsFile(env, page.captions_folder_id, licenseId),
    listMediaFiles(env, page.media_folder_id, licenseId),
  ]);

  if (!captionsFile) {
    return {
      captionsFile: null,
      captionsText: '',
      mediaFiles,
      selection: selectPairsOrdered({ mediaFiles, captionsText: '', blockedFileIds, excludeFileIds, excludeCaptionNumbers, limit }),
      missingCaptionsTxt: true,
    };
  }

  const captionsText = await downloadTextFile(env, captionsFile, licenseId);
  const selection = selectPairsOrdered({
    mediaFiles,
    captionsText,
    blockedFileIds,
    excludeFileIds,
    excludeCaptionNumbers,
    limit,
  });

  return {
    captionsFile,
    captionsText,
    mediaFiles,
    selection,
    missingCaptionsTxt: false,
  };
}

export async function syncDriveQueueForPage(env, page, { force = false } = {}) {
  if (!page.captions_folder_id || !page.media_folder_id) {
    return { synced: false, skippedReason: 'no_folders' };
  }

  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const localDateStr = getLocalParts(nowMs, page.timezone).localDate;

  const [planRes, blockedRes] = await env.DB.batch([
    env.DB.prepare(
      `SELECT id, status, file_id, file_name, caption_number, planned_utc
       FROM plan
       WHERE page_id = ? AND local_date = ?
       ORDER BY planned_utc ASC`
    ).bind(page.id, localDateStr),
    env.DB.prepare(`SELECT file_id FROM blocked_files WHERE page_id = ?`).bind(page.id),
  ]);

  const rows = planRes.results || [];
  const pendingSlots = rows.filter((r) => r.status === 'pending');
  const unfilled = pendingSlots.filter((r) => !r.file_id);

  // Stop rule: if all pending slots already have queued Drive items, do not re-sync unless forced manually
  if (!force && (pendingSlots.length === 0 || unfilled.length === 0)) {
    return {
      synced: false,
      skippedReason: pendingSlots.length === 0 ? 'no_pending_slots' : 'all_slots_filled',
      pendingCount: pendingSlots.length,
      filledCount: pendingSlots.length - unfilled.length,
    };
  }

  const excludeFileIds = new Set();
  const excludeCaptionNumbers = new Set();
  for (const r of rows) {
    if (r.status === 'posted' || r.status === 'posting') {
      if (r.file_id) excludeFileIds.add(r.file_id);
      if (r.caption_number != null) excludeCaptionNumbers.add(Number(r.caption_number));
    }
  }
  const blockedIds = new Set((blockedRes.results || []).map((b) => b.file_id));

  let inputs;
  try {
    inputs = await loadDriveInputsForPage(env, page, blockedIds, {
      excludeFileIds,
      excludeCaptionNumbers,
      limit: Math.max(25, pendingSlots.length + 5),
    });
  } catch (err) {
    await env.DB.prepare(
      `UPDATE pages SET last_drive_sync_at = ?, last_drive_sync_error = ?, updated_at = ? WHERE id = ?`
    )
      .bind(nowIso, err.message, nowIso, page.id)
      .run();
    return { synced: false, error: err.message };
  }

  const pairs = inputs.selection.pairs || [];
  const stmts = [];
  for (let i = 0; i < pendingSlots.length; i++) {
    const slot = pendingSlots[i];
    const pair = pairs[i] || null;
    if (pair) {
      stmts.push(
        env.DB.prepare(
          `UPDATE plan SET file_id = ?, file_name = ?, caption_number = ?, caption_text = ? WHERE id = ?`
        ).bind(pair.file.id, pair.file.name, pair.number, pair.caption.text, slot.id)
      );
    } else if (slot.file_id) {
      stmts.push(
        env.DB.prepare(
          `UPDATE plan SET file_id = NULL, file_name = NULL, caption_number = NULL, caption_text = NULL WHERE id = ?`
        ).bind(slot.id)
      );
    }
  }

  const syncErrMsg = inputs.missingCaptionsTxt
    ? 'Captions file (captions.txt / caption.txt / Google Doc) not found'
    : null;
  stmts.push(
    env.DB.prepare(
      `UPDATE pages SET last_drive_sync_at = ?, last_drive_sync_error = ? WHERE id = ?`
    ).bind(nowIso, syncErrMsg, page.id)
  );

  if (stmts.length > 0) {
    await env.DB.batch(stmts);
  }

  return {
    synced: true,
    pendingCount: pendingSlots.length,
    filledCount: Math.min(pendingSlots.length, pairs.length),
    availablePairs: pairs.length,
    missingCaptionsTxt: inputs.missingCaptionsTxt,
  };
}

export async function previewNextPostForPage(env, pageId) {
  const [page, blockedRes] = await env.DB.batch([
    env.DB.prepare(
      `SELECT p.*, a.name AS account_name, a.status AS account_status
       FROM pages p JOIN accounts a ON a.id = p.account_id
       WHERE p.id = ?`
    ).bind(pageId),
    env.DB.prepare(`SELECT file_id, file_name, reason FROM blocked_files WHERE page_id = ?`).bind(pageId),
  ]);

  const pageRow = page.results?.[0];
  if (!pageRow) {
    throw new Error('Page not found');
  }

  const blockedRows = blockedRes.results || [];
  const blockedIds = new Set(blockedRows.map((b) => b.file_id));
  const warnings = [];

  if (!pageRow.captions_folder_id || !pageRow.media_folder_id) {
    return {
      pageId: pageRow.id,
      pageName: pageRow.name,
      ready: false,
      warnings: ['Drive folders are not configured yet for this Page.'],
      pair: null,
      orphanFiles: [],
      orphanCaptions: [],
      invalidMediaFiles: [],
      duplicateCaptions: [],
      blockedFiles: blockedRows,
    };
  }

  const inputs = await loadDriveInputsForPage(env, pageRow, blockedIds);

  if (inputs.missingCaptionsTxt) {
    warnings.push('No captions file (captions.txt, caption.txt, or Google Doc) was found in the Captions folder.');
  } else if (inputs.captionsFile && inputs.captionsFile.capabilities?.canEdit === false) {
    warnings.push(`${inputs.captionsFile.name} is view-only. Grant Editor permission on Google Drive so RM Automation can update it.`);
  }

  if (inputs.selection.duplicateCaptions.length > 0) {
    warnings.push(`Duplicate caption numbers: ${inputs.selection.duplicateCaptions.join(', ')}`);
  }
  if (inputs.selection.orphanFiles.length > 0) {
    warnings.push(`${inputs.selection.orphanFiles.length} orphan media file(s) without matching caption.`);
  }
  if (inputs.selection.orphanCaptions.length > 0) {
    warnings.push(`${inputs.selection.orphanCaptions.length} orphan caption(s) without matching media file.`);
  }
  if (inputs.selection.invalidMediaFiles.length > 0) {
    warnings.push(`${inputs.selection.invalidMediaFiles.length} media file(s) skipped due to name/extension.`);
  }
  if (blockedRows.length > 0) {
    warnings.push(`${blockedRows.length} blocked file(s) excluded.`);
  }

  return {
    pageId: pageRow.id,
    pageName: pageRow.name,
    ready: Boolean(inputs.selection.pair),
    warnings,
    pair: inputs.selection.pair
      ? {
          number: inputs.selection.pair.number,
          fileId: inputs.selection.pair.file.id,
          fileName: inputs.selection.pair.file.name,
          mediaType: inputs.selection.pair.file.mediaType,
          sizeBytes: inputs.selection.pair.file.sizeBytes,
          captionText: inputs.selection.pair.caption.text,
        }
      : null,
    orphanFiles: inputs.selection.orphanFiles,
    orphanCaptions: inputs.selection.orphanCaptions,
    invalidMediaFiles: inputs.selection.invalidMediaFiles,
    duplicateCaptions: inputs.selection.duplicateCaptions,
    blockedFiles: blockedRows,
    totalMediaFiles: inputs.selection.totalMediaFiles,
    totalCaptions: inputs.selection.totalCaptions,
  };
}

export async function executeCleanupForItem(env, page, item) {
  const licenseId = page.license_id ?? null;
  try {
    // Step (2): Re-read captions file right before writing, remove caption block, upload with uploadType=media
    if (page.captions_folder_id && item.caption_number != null) {
      const captionsFile = await findCaptionsFile(env, page.captions_folder_id, licenseId);
      if (captionsFile) {
        let latestText = await downloadTextFile(env, captionsFile, licenseId);
        let { updatedText, removed } = removeCaptionBlock(latestText, item.caption_number);
        if (removed) {
          try {
            await updateTextFile(env, captionsFile, updatedText, licenseId);
          } catch (uploadErr) {
            // Re-read and re-apply once if concurrent modification or transient Drive error occurred
            latestText = await downloadTextFile(env, captionsFile, licenseId);
            const retryResult = removeCaptionBlock(latestText, item.caption_number);
            if (retryResult.removed) {
              await updateTextFile(env, captionsFile, retryResult.updatedText, licenseId);
            }
          }
        }
      }
    }

    // Step (3): Move media file to Drive trash (never permanent delete)
    if (item.file_id) {
      try {
        await trashFile(env, item.file_id, licenseId);
      } catch (trashErr) {
        if (trashErr.status !== 404) throw trashErr;
      }
    }

    // Clear cleanup_pending flag
    await env.DB.batch([
      env.DB.prepare(`UPDATE plan SET cleanup_pending = 0 WHERE id = ?`).bind(item.id),
      prepareEventStmt(env.DB, {
        pageId: page.id,
        licenseId,
        level: 'info',
        eventType: 'cleanup_completed',
        message: `Cleaned up Drive item #${item.caption_number} (${item.file_name})`,
        details: { planId: item.id, fileId: item.file_id, captionNumber: item.caption_number },
      }),
    ]);
    return true;
  } catch (err) {
    await env.DB.batch([
      prepareEventStmt(env.DB, {
        pageId: page.id,
        licenseId,
        level: 'warn',
        eventType: 'cleanup_pending',
        message: `Drive cleanup failed (will retry, never repost): ${err.message}`,
        details: { planId: item.id, fileId: item.file_id, captionNumber: item.caption_number },
      }),
    ]);
    return false;
  }
}

async function executeClaimedItem(env, page, item, blockedFileIds) {
  const nowIso = new Date().toISOString();
  const licenseId = page.license_id ?? null;
  let pageToken;
  try {
    pageToken = await decryptText(page.encrypted_page_token, env.ENCRYPTION_KEY);
  } catch (err) {
    await env.DB.batch([
      env.DB.prepare(`UPDATE pages SET status = 'needs_attention', last_error = ?, updated_at = ? WHERE id = ?`).bind(
        `Token decryption failed: ${err.message}`,
        nowIso,
        page.id
      ),
      env.DB.prepare(`UPDATE plan SET status = 'failed', error = ?, finished_at = ? WHERE id = ?`).bind(
        err.message,
        nowIso,
        item.id
      ),
      prepareEventStmt(env.DB, {
        pageId: page.id,
        licenseId,
        level: 'error',
        eventType: 'token_decrypt_failed',
        message: err.message,
      }),
    ]);
    return { status: 'failed', error: err.message };
  }

  // Guard against picking an item already posted/posting today if Drive cleanup lagged
  const todayRowsRes = await env.DB.prepare(
    `SELECT id, file_id, caption_number FROM plan
     WHERE page_id = ? AND local_date = ? AND status IN ('posted', 'posting') AND id != ?`
  )
    .bind(page.id, item.local_date, item.id)
    .all();

  const excludeFileIds = new Set();
  const excludeCaptionNumbers = new Set();
  for (const r of todayRowsRes.results || []) {
    if (r.file_id) excludeFileIds.add(r.file_id);
    if (r.caption_number != null) excludeCaptionNumbers.add(Number(r.caption_number));
  }

  let inputs;
  try {
    inputs = await loadDriveInputsForPage(env, page, blockedFileIds, {
      excludeFileIds,
      excludeCaptionNumbers,
    });
  } catch (err) {
    if (err.isConfigError) {
      await env.DB.batch([
        env.DB.prepare(`UPDATE pages SET status = 'needs_attention', last_error = ?, updated_at = ? WHERE id = ?`).bind(
          err.message,
          nowIso,
          page.id
        ),
        env.DB.prepare(`UPDATE plan SET status = 'failed', error = ?, finished_at = ? WHERE id = ?`).bind(
          err.message,
          nowIso,
          item.id
        ),
        prepareEventStmt(env.DB, {
          pageId: page.id,
          licenseId,
          level: 'error',
          eventType: 'drive_config_error',
          message: err.message,
        }),
      ]);
      return { status: 'failed', error: err.message };
    }

    // Drive network/API failure -> retriable
    return handleRetriableOrExhaustedFailure(env, page, item, null, {
      message: `Drive read error: ${err.message}`,
      retriable: true,
      nonRetriable: false,
      isTokenError: false,
    });
  }

  // Loop so that >100 MB files get blocked immediately and we try the next pair
  let attemptSelection = inputs.selection;
  const pickPairFromSelection = (sel) => {
    if (item.file_id && sel.pairs?.length) {
      const preAssigned = sel.pairs.find(
        (pr) => pr.file.id === item.file_id && (item.caption_number == null || pr.number === Number(item.caption_number))
      );
      if (preAssigned) return preAssigned;
    }
    return sel.pair;
  };

  let currentPair = pickPairFromSelection(attemptSelection);
  while (currentPair) {
    const { file, caption, number } = currentPair;

    // Save chosen file + caption metadata BEFORE posting so stuck-posting reconciliation can inspect it
    await env.DB.prepare(
      `UPDATE plan SET file_id = ?, file_name = ?, caption_number = ?, caption_text = ? WHERE id = ?`
    )
      .bind(file.id, file.name, number, caption.text, item.id)
      .run();

    item.file_id = file.id;
    item.file_name = file.name;
    item.caption_number = number;
    item.caption_text = caption.text;

    let blob;
    try {
      blob = await downloadMediaBlob(env, file, licenseId);
    } catch (dlErr) {
      if (dlErr.isTooLarge) {
        blockedFileIds.add(file.id);
        await env.DB.batch([
          env.DB.prepare(
            `INSERT OR IGNORE INTO blocked_files (page_id, file_id, file_name, reason, attempts, created_at)
             VALUES (?, ?, ?, ?, 1, ?)`
          ).bind(page.id, file.id, file.name, dlErr.message, nowIso),
          prepareEventStmt(env.DB, {
            pageId: page.id,
            licenseId,
            level: 'error',
            eventType: 'file_blocked_size',
            message: dlErr.message,
            details: { fileId: file.id, fileName: file.name },
          }),
        ]);
        attemptSelection = selectNextPair({
          mediaFiles: inputs.mediaFiles,
          captionsText: inputs.captionsText,
          blockedFileIds,
          excludeFileIds,
          excludeCaptionNumbers,
        });
        currentPair = attemptSelection.pair;
        continue;
      }

      return handleRetriableOrExhaustedFailure(env, page, item, file, {
        message: `Drive download failed for ${file.name}: ${dlErr.message}`,
        retriable: true,
        nonRetriable: false,
        isTokenError: false,
      });
    }

    try {
      let fbPostId = '';
      if (file.mediaType === 'video') {
        fbPostId = await postVideoToPage(env, {
          fbPageId: page.fb_page_id,
          pageToken,
          blob,
          filename: file.name,
          description: caption.text,
        });
      } else {
        fbPostId = await postPhotoToPage(env, {
          fbPageId: page.fb_page_id,
          pageToken,
          blob,
          filename: file.name,
          caption: caption.text,
        });
      }

      const postedAt = new Date().toISOString();
      // Step (1): Persist posted state + fb_post_id + cleanup_pending=1 immediately
      await env.DB.batch([
        env.DB.prepare(
          `UPDATE plan
           SET status = 'posted', fb_post_id = ?, finished_at = ?, error = NULL, cleanup_pending = 1
           WHERE id = ?`
        ).bind(fbPostId, postedAt, item.id),
        env.DB.prepare(`UPDATE pages SET last_error = NULL, updated_at = ? WHERE id = ?`).bind(postedAt, page.id),
        prepareEventStmt(env.DB, {
          pageId: page.id,
          licenseId,
          level: 'info',
          eventType: 'post_published',
          message: `Published #${number} (${file.name}) -> FB post ${fbPostId}`,
          details: { planId: item.id, fbPostId, fileId: file.id, fileName: file.name, captionNumber: number },
        }),
      ]);

      // Steps (2) & (3): Remove caption block + Trash media file
      await executeCleanupForItem(env, page, item);
      return { status: 'posted', fbPostId, fileName: file.name, captionNumber: number };
    } catch (postErr) {
      const fbInfo = postErr.fbInfo || classifyFacebookError(postErr.status || 0, null, postErr.message);

      if (fbInfo.nonRetriable) {
        const errAt = new Date().toISOString();
        await env.DB.batch([
          env.DB.prepare(`UPDATE pages SET status = 'needs_attention', last_error = ?, updated_at = ? WHERE id = ?`).bind(
            fbInfo.message,
            errAt,
            page.id
          ),
          env.DB.prepare(`UPDATE plan SET status = 'failed', error = ?, finished_at = ? WHERE id = ?`).bind(
            fbInfo.message,
            errAt,
            item.id
          ),
          prepareEventStmt(env.DB, {
            pageId: page.id,
            licenseId,
            level: 'error',
            eventType: 'fb_non_retriable_error',
            message: fbInfo.message,
            details: { code: fbInfo.code, subcode: fbInfo.subcode, fileId: file.id, fileName: file.name },
          }),
        ]);
        return { status: 'needs_attention', error: fbInfo.message };
      }

      return handleRetriableOrExhaustedFailure(env, page, item, file, fbInfo);
    }
  }

  // No pair left (either empty folders, orphans only, or all remaining files blocked)
  const skipMsg = inputs.missingCaptionsTxt
    ? 'captions.txt not found in Captions folder'
    : 'No matching file & caption pair available';
  const finishedAt = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(`UPDATE plan SET status = 'skipped', error = ?, finished_at = ? WHERE id = ?`).bind(
      skipMsg,
      finishedAt,
      item.id
    ),
    prepareEventStmt(env.DB, {
      pageId: page.id,
      licenseId,
      level: 'warn',
      eventType: 'no_pair_available',
      message: skipMsg,
      details: {
        orphanFiles: attemptSelection.orphanFiles.length,
        orphanCaptions: attemptSelection.orphanCaptions.length,
      },
    }),
  ]);
  return { status: 'skipped', error: skipMsg };
}

async function handleRetriableOrExhaustedFailure(env, page, item, file, info) {
  const nextAttempts = Number(item.attempts || 0) + 1;
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const licenseId = page.license_id ?? null;

  if (nextAttempts < MAX_ATTEMPTS) {
    const backoffMins = BACKOFF_MINUTES[Math.min(nextAttempts - 1, BACKOFF_MINUTES.length - 1)];
    const nextAttemptIso = new Date(nowMs + backoffMins * 60_000).toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE plan
         SET status = 'pending', attempts = ?, next_attempt_utc = ?, error = ?, claimed_at = NULL
         WHERE id = ?`
      ).bind(nextAttempts, nextAttemptIso, info.message, item.id),
      env.DB.prepare(`UPDATE pages SET last_error = ?, updated_at = ? WHERE id = ?`).bind(info.message, nowIso, page.id),
      prepareEventStmt(env.DB, {
        pageId: page.id,
        licenseId,
        level: 'warn',
        eventType: 'post_retry_scheduled',
        message: `Attempt ${nextAttempts}/${MAX_ATTEMPTS} failed (${info.message}); retry in ${backoffMins}m`,
        details: { planId: item.id, fileId: file?.id, fileName: file?.name, backoffMins },
      }),
    ]);
    return { status: 'retrying', attempts: nextAttempts, nextAttemptUtc: nextAttemptIso, error: info.message };
  }

  // Max 5 attempts reached -> if non-token error tied to a specific file, block that file so future slots continue
  const stmts = [
    env.DB.prepare(
      `UPDATE plan SET status = 'failed', attempts = ?, error = ?, finished_at = ? WHERE id = ?`
    ).bind(nextAttempts, info.message, nowIso, item.id),
    env.DB.prepare(`UPDATE pages SET last_error = ?, updated_at = ? WHERE id = ?`).bind(info.message, nowIso, page.id),
  ];

  if (file && file.id && !info.isTokenError) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO blocked_files (page_id, file_id, file_name, reason, attempts, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(page_id, file_id) DO UPDATE SET reason = excluded.reason, attempts = excluded.attempts`
      ).bind(page.id, file.id, file.name, info.message, nextAttempts, nowIso)
    );
    stmts.push(
      prepareEventStmt(env.DB, {
        pageId: page.id,
        licenseId,
        level: 'error',
        eventType: 'file_blocked_failures',
        message: `Blocked "${file.name}" after ${nextAttempts} failures: ${info.message}`,
        details: { planId: item.id, fileId: file.id, fileName: file.name },
      })
    );
  } else {
    stmts.push(
      prepareEventStmt(env.DB, {
        pageId: page.id,
        licenseId,
        level: 'error',
        eventType: 'post_failed_permanently',
        message: `Failed after ${nextAttempts} attempts: ${info.message}`,
        details: { planId: item.id },
      })
    );
  }

  await env.DB.batch(stmts);
  return { status: 'failed', attempts: nextAttempts, error: info.message };
}

export async function postNowForPage(env, pageId) {
  const [pageRes, blockedRes] = await env.DB.batch([
    env.DB.prepare(
      `SELECT p.*, a.status AS account_status
       FROM pages p JOIN accounts a ON a.id = p.account_id
       WHERE p.id = ?`
    ).bind(pageId),
    env.DB.prepare(`SELECT file_id FROM blocked_files WHERE page_id = ?`).bind(pageId),
  ]);

  const page = pageRes.results?.[0];
  if (!page) throw new Error('Page not found');
  if (page.account_status !== 'active') {
    throw new Error('Parent Facebook account is not active. Reconnect it first.');
  }

  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const parts = getLocalParts(nowMs, page.timezone);

  const insertRes = await env.DB.prepare(
    `INSERT INTO plan (page_id, local_date, slot_time, planned_local, planned_utc, status, claimed_at, cleanup_pending)
     VALUES (?, ?, 'manual', ?, ?, 'posting', ?, 0)`
  )
    .bind(page.id, parts.localDate, parts.localTime, nowIso, nowIso)
    .run();

  const item = {
    id: insertRes.meta.last_row_id,
    page_id: page.id,
    local_date: parts.localDate,
    slot_time: 'manual',
    planned_local: parts.localTime,
    planned_utc: nowIso,
    status: 'posting',
    attempts: 0,
  };

  const blockedIds = new Set((blockedRes.results || []).map((r) => r.file_id));
  return executeClaimedItem(env, page, item, blockedIds);
}

async function reconcileStuckPostingItems(env, stuckItems, pagesById) {
  const nowIso = new Date().toISOString();
  for (const item of stuckItems.slice(0, 3)) {
    const page = pagesById.get(item.page_id);
    if (!page) continue;

    let matched = null;
    try {
      const pageToken = await decryptText(page.encrypted_page_token, env.ENCRYPTION_KEY);
      const recent = await fetchRecentPagePosts(env, { fbPageId: page.fb_page_id, pageToken });
      const targetCaption = (item.caption_text || '').trim();
      const claimedMs = Date.parse(item.claimed_at || item.planned_utc);

      matched = recent.find((p) => {
        const postMs = p.created_time ? Date.parse(p.created_time) : claimedMs;
        const nearTime = Math.abs(postMs - claimedMs) <= 35 * 60_000;
        if (!nearTime) return false;
        if (targetCaption) {
          return p.text === targetCaption;
        }
        return true;
      });
    } catch {
      matched = null;
    }

    if (matched) {
      await env.DB.batch([
        env.DB.prepare(
          `UPDATE plan SET status = 'posted', fb_post_id = ?, finished_at = ?, cleanup_pending = 1, error = NULL WHERE id = ?`
        ).bind(matched.id, nowIso, item.id),
        prepareEventStmt(env.DB, {
          pageId: page.id,
          licenseId: page.license_id ?? null,
          level: 'info',
          eventType: 'reconciled_posted',
          message: `Reconciled stuck posting item #${item.id} as posted (${matched.id})`,
        }),
      ]);
      item.fb_post_id = matched.id;
      await executeCleanupForItem(env, page, item);
    } else {
      await env.DB.batch([
        env.DB.prepare(
          `UPDATE plan SET status = 'pending', claimed_at = NULL, error = 'Reconciled: not found on FB, reset to pending' WHERE id = ?`
        ).bind(item.id),
        prepareEventStmt(env.DB, {
          pageId: page.id,
          licenseId: page.license_id ?? null,
          level: 'warn',
          eventType: 'reconciled_reset',
          message: `Reset stuck posting item #${item.id} back to pending`,
        }),
      ]);
    }
  }
}

function isPageLicenseRunnable(page, nowMs) {
  if (page.license_id == null) return true;
  if (page.license_status !== 'active') return false;
  if (Number(page.license_global_pause) === 1) return false;
  if (page.license_expires_at) {
    const expMs = Date.parse(page.license_expires_at);
    if (!Number.isNaN(expMs) && expMs <= nowMs) return false;
  }
  return true;
}

export async function runCron(env) {
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const lateCutoffIso = new Date(nowMs - LATE_CUTOFF_MS).toISOString();
  const stuckCutoffIso = new Date(nowMs - STUCK_POSTING_MS).toISOString();
  const lookbackDate = new Date(nowMs - 48 * 3600_000).toISOString().slice(0, 10);

  // Batch 1: read global pause, pages+accounts+licenses, recent/active plan rows, blocked files (4 queries)
  const [settingsRes, pagesRes, planRes, blockedRes] = await env.DB.batch([
    env.DB.prepare(`SELECT value FROM settings WHERE key = 'global_pause'`),
    env.DB.prepare(
      `SELECT p.*, a.status AS account_status,
              l.status AS license_status,
              l.expires_at AS license_expires_at,
              l.global_pause AS license_global_pause
       FROM pages p
       JOIN accounts a ON a.id = p.account_id
       LEFT JOIN licenses l ON l.id = p.license_id`
    ),
    env.DB.prepare(
      `SELECT * FROM plan
       WHERE local_date >= ? OR status = 'posting' OR cleanup_pending = 1`
    ).bind(lookbackDate),
    env.DB.prepare(`SELECT page_id, file_id FROM blocked_files`),
  ]);

  const globalPause = settingsRes.results?.[0]?.value === '1';
  const allPages = pagesRes.results || [];
  const allPlans = planRes.results || [];

  const pagesById = new Map();
  const activePages = [];
  for (const p of allPages) {
    pagesById.set(p.id, p);
    if (p.status === 'active' && p.account_status === 'active' && isPageLicenseRunnable(p, nowMs)) {
      activePages.push(p);
    }
  }

  const blockedByPage = new Map();
  for (const b of blockedRes.results || []) {
    if (!blockedByPage.has(b.page_id)) blockedByPage.set(b.page_id, new Set());
    blockedByPage.get(b.page_id).add(b.file_id);
  }

  // Generate today's plan for any active page missing a plan for its local_date
  const existingPageDates = new Set(allPlans.map((r) => `${r.page_id}:${r.local_date}`));
  const generatedRows = [];
  for (const page of activePages) {
    const localDateStr = getLocalParts(nowMs, page.timezone).localDate;
    const key = `${page.id}:${localDateStr}`;
    if (!existingPageDates.has(key)) {
      const rows = buildPlanRowsForPage(page, localDateStr, nowMs);
      generatedRows.push(...rows);
    }
  }
  if (generatedRows.length > 0) {
    await insertPlanRowsBatch(env.DB, generatedRows);
    // Re-fetch today's pending rows only if we generated new ones
    const freshRes = await env.DB.prepare(
      `SELECT * FROM plan WHERE local_date >= ? OR status = 'posting' OR cleanup_pending = 1`
    )
      .bind(lookbackDate)
      .all();
    allPlans.length = 0;
    allPlans.push(...(freshRes.results || []));
  }

  // Mark unattempted pending items >90 min late as missed (1 query)
  await env.DB.prepare(
    `UPDATE plan
     SET status = 'missed', finished_at = ?, error = 'Missed: >90 min past planned time'
     WHERE status = 'pending' AND attempts = 0 AND planned_utc < ?`
  )
    .bind(nowIso, lateCutoffIso)
    .run();

  // Reconcile stuck 'posting' items older than 10 minutes
  const stuckItems = allPlans.filter(
    (r) => r.status === 'posting' && r.claimed_at && r.claimed_at < stuckCutoffIso
  );
  if (stuckItems.length > 0) {
    await reconcileStuckPostingItems(env, stuckItems, pagesById);
  }

  // Retry pending cleanups (up to 2 per run, even if global_pause is on, never reposts)
  const pendingCleanups = allPlans.filter((r) => r.status === 'posted' && Number(r.cleanup_pending) === 1);
  for (const cItem of pendingCleanups.slice(0, 2)) {
    const page = pagesById.get(cItem.page_id);
    if (page) {
      await executeCleanupForItem(env, page, cItem);
    }
  }

  if (globalPause) {
    return;
  }

  // Compute last post/posting timestamp per page for min_gap enforcement
  const lastPostMsByPage = new Map();
  for (const r of allPlans) {
    if (r.status === 'posted' || r.status === 'posting') {
      const ts = Date.parse(r.finished_at || r.claimed_at || r.planned_utc);
      if (!Number.isNaN(ts)) {
        const prev = lastPostMsByPage.get(r.page_id) || 0;
        if (ts > prev) lastPostMsByPage.set(r.page_id, ts);
      }
    }
  }

  // Collect at most 1 due item per active page
  const dueByPage = new Map();
  for (const r of allPlans) {
    if (r.status !== 'pending') continue;
    const page = pagesById.get(r.page_id);
    if (
      !page ||
      page.status !== 'active' ||
      page.account_status !== 'active' ||
      !isPageLicenseRunnable(page, nowMs)
    ) {
      continue;
    }
    if (!page.captions_folder_id || !page.media_folder_id) continue;

    if (Number(r.attempts) === 0) {
      if (r.planned_utc > nowIso || r.planned_utc < lateCutoffIso) continue;
    } else {
      if (r.next_attempt_utc && r.next_attempt_utc > nowIso) continue;
    }

    const minGapMs = Math.max(0, Number(page.min_gap_minutes || 0)) * 60_000;
    const lastMs = lastPostMsByPage.get(page.id) || 0;
    if (lastMs > 0 && nowMs - lastMs < minGapMs) continue;

    const existing = dueByPage.get(page.id);
    if (!existing || r.planned_utc < existing.planned_utc) {
      dueByPage.set(page.id, r);
    }
  }

  const maxPosts = Math.max(1, Number(env.MAX_POSTS_PER_RUN || 3));
  const candidateEntries = shuffleInPlace(Array.from(dueByPage.entries())).slice(0, maxPosts);

  const dispatchedPageIds = new Set();
  for (const [pageId, item] of candidateEntries) {
    const page = pagesById.get(pageId);
    // Exactly-once claim: require changes === 1
    const claimRes = await env.DB.prepare(
      `UPDATE plan SET status = 'posting', claimed_at = ? WHERE id = ? AND status = 'pending'`
    )
      .bind(nowIso, item.id)
      .run();

    if ((claimRes.meta?.changes || 0) !== 1) {
      continue;
    }

    dispatchedPageIds.add(page.id);
    item.status = 'posting';
    item.claimed_at = nowIso;
    const blockedIds = blockedByPage.get(page.id) || new Set();
    await executeClaimedItem(env, page, item, blockedIds);
  }

  // Smart pre-sync (pre-post check <=12m before due OR hourly sync) ONLY for pages with unfilled pending slots
  const preSyncWindowIso = new Date(nowMs + 12 * 60_000).toISOString();
  const hourAgoMs = nowMs - 60 * 60_000;
  const syncCandidates = [];

  for (const page of activePages) {
    if (dispatchedPageIds.has(page.id)) continue;
    if (!page.captions_folder_id || !page.media_folder_id) continue;

    const localDateStr = getLocalParts(nowMs, page.timezone).localDate;
    const unfilledSlots = allPlans.filter(
      (r) => r.page_id === page.id && r.local_date === localDateStr && r.status === 'pending' && !r.file_id
    );
    if (unfilledSlots.length === 0) continue; // Stop rule: all pending slots already queued!

    const earliestUnfilled = unfilledSlots.reduce(
      (min, r) => (r.planned_utc < min ? r.planned_utc : min),
      unfilledSlots[0].planned_utc
    );
    const isDueSoon = earliestUnfilled <= preSyncWindowIso;
    const lastSyncMs = page.last_drive_sync_at ? Date.parse(page.last_drive_sync_at) : 0;
    const isHourlyDue = !lastSyncMs || Number.isNaN(lastSyncMs) || lastSyncMs <= hourAgoMs;

    if (isDueSoon || isHourlyDue) {
      syncCandidates.push({ page, isDueSoon, lastSyncMs: lastSyncMs || 0 });
    }
  }

  syncCandidates.sort((a, b) => {
    if (a.isDueSoon !== b.isDueSoon) return a.isDueSoon ? -1 : 1;
    return a.lastSyncMs - b.lastSyncMs;
  });

  for (const c of syncCandidates.slice(0, 2)) {
    await syncDriveQueueForPage(env, c.page, { force: false }).catch(() => null);
  }

  // Prune logs (events) and historical posts (plan) older than 7 days (~every 15 min)
  if (new Date(nowMs).getUTCMinutes() % 15 === 0) {
    await pruneExpiredHistory(env.DB, nowMs);
  }
}

export async function pruneExpiredHistory(db, nowMs = Date.now()) {
  const cutoff7dIso = new Date(nowMs - 7 * 86400_000).toISOString();
  await db.batch([
    db.prepare(`DELETE FROM events WHERE created_at < ?`).bind(cutoff7dIso),
    db.prepare(
      `DELETE FROM plan
       WHERE planned_utc < ?
         AND status != 'posting'
         AND cleanup_pending = 0`
    ).bind(cutoff7dIso),
  ]);
}
