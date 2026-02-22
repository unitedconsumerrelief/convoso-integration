const express = require("express");
const querystring = require("querystring");

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

/**
 * ENV VARS you will set in Render:
 * FORTH_API_KEY = current access token (expires; used as fallback if refresh creds missing)
 * FORTH_BASE_URL = https://api.forthcrm.com
 * FORTH_KEY_ID = permanent key id for token refresh
 * FORTH_API_SECRET = permanent secret for token refresh
 * SHARED_SECRET = a random string you will also put in Convoso (as a header value)
 * CONVOSO_AUTH_TOKEN = Convoso API auth token for Call Log Retrieve
 */
const FORTH_BASE_URL = process.env.FORTH_BASE_URL || "https://api.forthcrm.com";
const SHARED_SECRET = process.env.SHARED_SECRET;
const CONVOSO_AUTH_TOKEN = process.env.CONVOSO_AUTH_TOKEN;
const CONVOSO_API_BASE = "https://api.convoso.com";

// Forth access token refresh (token expires every 10 days)
let forthAccessToken = process.env.FORTH_API_KEY || null;
let forthTokenExpiresAt = 0;
let forthRefreshPromise = null;
let forthMissingCredsLogged = false;
const FORTH_TOKEN_BUFFER_MS = 6 * 60 * 60 * 1000;
const FORTH_TOKEN_DEFAULT_TTL_MS = 9 * 24 * 60 * 60 * 1000;

// Minimal disposition mapping (you can expand later)
const DISP = {
  NO_ANSWER: 1,
  CONNECTED: 2,
  LEFT_MESSAGE: 3,
  BUSY: 6
};

/**
 * Map Convoso outcome fields to Forth call_disposition ID and call_result label.
 * If no outcome fields present, returns { dispId: DISP.CONNECTED, call_result: "Logged", source: "default" }.
 */
function mapCallCompletedOutcome(convoso) {
  const termReason = String(convoso.term_reason ?? convoso.term_reason_id ?? "").trim();
  const statusName = String(convoso.status_name ?? convoso.status ?? "").trim();
  const disposition = String(convoso.disposition ?? convoso.disposition_name ?? "").trim();
  const callResult = String(convoso.call_result ?? "").trim();
  const talkSec = Number(convoso.talk_time ?? convoso.talk_seconds ?? 0);
  const combined = [termReason, statusName, disposition, callResult].join(" ").toLowerCase();

  const hasOutcome = talkSec > 0 || termReason || statusName || disposition || callResult;
  if (!hasOutcome) {
    return { dispId: DISP.CONNECTED, call_result: "Logged", source: "default" };
  }

  if (talkSec > 0) {
    return { dispId: DISP.CONNECTED, call_result: "Connected", source: "convoso" };
  }
  if (/no answer|noanswer|na\b/i.test(combined)) {
    return { dispId: DISP.NO_ANSWER, call_result: "No Answer", source: "convoso" };
  }
  if (/busy/i.test(combined)) {
    return { dispId: DISP.BUSY, call_result: "Busy", source: "convoso" };
  }
  if (/left|vm|voicemail|message/i.test(combined)) {
    return { dispId: DISP.LEFT_MESSAGE, call_result: "Left Message", source: "convoso" };
  }
  return { dispId: DISP.CONNECTED, call_result: "Connected", source: "convoso" };
}

// First-disposition dedupe: key = disp_first_set:${call_id} or disp_first_set:${lead_id}:${ts}. TTL 30 days.
const firstDispositionSeen = new Map();
const FIRST_DISPOSITION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function pruneFirstDispositionSeen() {
  const now = Date.now();
  for (const [k, v] of firstDispositionSeen.entries()) {
    if (now - v.ts > FIRST_DISPOSITION_TTL_MS) firstDispositionSeen.delete(k);
  }
}

function normalizePhone(raw) {
  if (!raw) return "";
  // keep digits only
  const d = String(raw).replace(/\D/g, "");
  // if 11 digits starting with 1, drop leading 1
  if (d.length === 11 && d.startsWith("1")) return d.slice(1);
  return d;
}

/**
 * Parse Convoso body: support direct JSON or req.body.params (x-www-form-urlencoded string).
 * Returns { ...parsedFields, phone, _inputType } where phone is normalized for lookup (digits).
 */
function parseConvosoBody(req) {
  const body = req.body || {};
  if (typeof body.params === "string") {
    const parsed = querystring.parse(body.params);
    const phoneNumber = String(parsed.phone_number ?? parsed.phone ?? "").trim();
    const phoneCode = String(parsed.phone_code ?? "").trim();
    const digits = normalizePhone(phoneNumber);
    const phone = digits;
    const phoneE164 = phoneCode && digits ? `+${phoneCode}${digits}` : null;
    const convoso = { ...parsed, phone, phone_number: phoneNumber, phone_code: phoneCode, phoneE164, _inputType: "params" };
    return convoso;
  }
  const rawPhone = body.phone || body.phone_number || body.caller_id || body.lead_phone;
  const convoso = { ...body, phone: normalizePhone(rawPhone), _inputType: "json" };
  return convoso;
}

/**
 * Normalize a plain object (from JSON array element or JSON object) for call-completed: phone, call_type, call_log_id.
 */
function normalizePayloadObject(raw, _inputType) {
  const phoneNumber = String(raw.phone_number ?? raw.phone ?? raw.primary_phone ?? raw.PhoneNumber ?? "").trim();
  const phone = normalizePhone(phoneNumber);
  const call_type = raw.call_type ?? raw.callType ?? raw.CallType ?? "";
  const call_log_id = raw.call_log_id ?? raw.callLogId ?? "";
  return { ...raw, phone_number: phoneNumber, phone, call_type, call_log_id, _inputType };
}

/**
 * Normalize incoming request body for POST /convoso/call-completed.
 * Accepts: params string (querystring), JSON array, JSON object, or params as array/object.
 * Returns single payload object with phone, phone_number, call_type, call_log_id, _inputType.
 */
function normalizeIncomingPayload(req) {
  const body = req.body || {};
  if (typeof body.params === "string") {
    const parsed = querystring.parse(body.params);
    const phoneNumber = String(parsed.phone_number ?? parsed.phone ?? "").trim();
    const phoneCode = String(parsed.phone_code ?? "").trim();
    const digits = normalizePhone(phoneNumber);
    const phoneE164 = phoneCode && digits ? `+${phoneCode}${digits}` : null;
    const convoso = { ...parsed, phone: digits, phone_number: phoneNumber, phone_code: phoneCode, phoneE164, _inputType: "params" };
    return convoso;
  }
  if (Array.isArray(body)) {
    const raw = body[0] || {};
    return normalizePayloadObject(raw, "json_array");
  }
  if (Array.isArray(body.params)) {
    const raw = body.params[0] || {};
    return normalizePayloadObject(raw, "json_params_array");
  }
  if (body.params && typeof body.params === "object" && !Array.isArray(body.params)) {
    return normalizePayloadObject(body.params, "json_params_object");
  }
  return normalizePayloadObject(body, "json_object");
}

function logConvosoRequest(routeName, convoso) {
  const inputType = convoso._inputType || "json";
  const last4 = convoso.phone && convoso.phone.length >= 4 ? convoso.phone.slice(-4) : "none";
  console.log(`[${routeName}] parsed=${inputType} phone_last4=${last4}`);
}

function requireSecret(req, res) {
  if (!SHARED_SECRET) return true; // allow if you didn't set it yet
  const got = req.get("X-Shared-Secret");
  if (got !== SHARED_SECRET) {
    res.status(401).json({ ok: false, error: "Unauthorized" });
    return false;
  }
  return true;
}

async function refreshForthAccessToken() {
  if (forthRefreshPromise) return forthRefreshPromise;
  forthRefreshPromise = (async () => {
    try {
      const clientId = process.env.FORTH_KEY_ID;
      const clientSecret = process.env.FORTH_API_SECRET;
      if (!clientId || !clientSecret) throw new Error("FORTH_KEY_ID or FORTH_API_SECRET missing");
      const url = `${FORTH_BASE_URL}/v1/auth/token`;
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: clientId, client_secret: clientSecret })
      });
      const j = await r.json();
      console.log("[forth-auth] token refresh response status=" + r.status + " keys=" + JSON.stringify(Object.keys(j).sort()));
      if (j && typeof j.data === "object" && j.data !== null) {
        console.log("[forth-auth] token refresh response data_keys=" + JSON.stringify(Object.keys(j.data).sort()));
      }
      if (!r.ok) throw new Error(j?.message ?? j?.error ?? "HTTP " + r.status);
      const token = j?.response?.access_token ?? j?.response?.token ?? j?.access_token ?? j?.token ?? null;
      if (!token) throw new Error("No access_token in response");
      forthAccessToken = token;
      const expiresIn = j?.response?.expires_in ?? j?.expires_in;
      forthTokenExpiresAt = expiresIn
        ? Date.now() + Math.min(Number(expiresIn) * 1000, FORTH_TOKEN_DEFAULT_TTL_MS)
        : Date.now() + FORTH_TOKEN_DEFAULT_TTL_MS;
      console.log("[forth-auth] refreshed token, expiresAt=" + new Date(forthTokenExpiresAt).toISOString());
      return forthAccessToken;
    } finally {
      forthRefreshPromise = null;
    }
  })();
  try {
    return await forthRefreshPromise;
  } catch (e) {
    console.log("[forth-auth] refresh failed: " + (e?.message ?? String(e)));
    throw e;
  }
}

async function getForthApiKey() {
  const keyId = process.env.FORTH_KEY_ID;
  const secret = process.env.FORTH_API_SECRET;
  if (!keyId || !secret) {
    if (!forthMissingCredsLogged) {
      forthMissingCredsLogged = true;
      console.log("[forth-auth] missing creds; using FORTH_API_KEY only");
    }
    return process.env.FORTH_API_KEY || "";
  }
  if (forthAccessToken && Date.now() < forthTokenExpiresAt - FORTH_TOKEN_BUFFER_MS) return forthAccessToken;
  return refreshForthAccessToken();
}

async function forthFetch(url, options) {
  const apiKey = await getForthApiKey();
  const headers = { ...options?.headers, "Api-Key": apiKey };
  let r = await fetch(url, { ...options, headers });
  if (r.status === 401 || r.status === 403) {
    console.log("[forth-auth] token rejected (401/403), refreshing and retrying once");
    forthAccessToken = null;
    forthTokenExpiresAt = 0;
    const newKey = await refreshForthAccessToken();
    const retryHeaders = { ...options?.headers, "Api-Key": newKey };
    r = await fetch(url, { ...options, headers: retryHeaders });
  }
  return r;
}

async function forthSearchContactByPhone(phone) {
  const url = `${FORTH_BASE_URL}/v1/contacts/search_by_phone/${encodeURIComponent(phone)}`;
  const r = await forthFetch(url, { method: "GET" });
  const j = await r.json();
  return { status: r.status, body: j };
}

function formatConvosoTime(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const h = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  const s = String(date.getSeconds()).padStart(2, "0");
  return `${y}-${m}-${d} ${h}:${min}:${s}`;
}

/**
 * Fetch Convoso Call Log for phone; returns newest log entry or null on failure/no data.
 * No start_time/end_time; order=desc so results[0] is newest.
 * Uses process.env.CONVOSO_AUTH_TOKEN at request time.
 */
async function fetchConvosoCallLog(phone) {
  const authToken = process.env.CONVOSO_AUTH_TOKEN;
  if (!authToken || !authToken.trim()) {
    console.log("[call-completed] enrichment skipped: missing CONVOSO_AUTH_TOKEN");
    return null;
  }
  if (!phone) return null;
  const phoneDigits = String(phone).replace(/\D/g, "");
  const params = new URLSearchParams({
    auth_token: authToken,
    phone_number: phoneDigits,
    order: "desc",
    limit: "5",
    include_recordings: "0"
  });
  const url = `${CONVOSO_API_BASE}/v1/log/retrieve?${params.toString()}`;
  const last10 = phoneDigits.length >= 10 ? phoneDigits.slice(-10) : phoneDigits;
  console.log("[call-completed] enrichment query phone_digits_len=" + phoneDigits.length + " phone_last10=" + last10);
  const timeoutMs = 15000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const delays = [0, 3000, 5000];
  try {
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (attempt > 1) {
        await new Promise((r) => setTimeout(r, delays[attempt - 1]));
      }
      const r = await fetch(url, { method: "GET", signal: controller.signal });
      const j = await r.json();
      if (!r.ok) {
        clearTimeout(timeoutId);
        console.log("[call-completed] enrichment fetch fail: HTTP " + r.status + " " + (j?.message ?? j?.error ?? ""));
        return null;
      }
      const list = j?.data ?? j?.logs ?? Array.isArray(j) ? j : [];
      if (Array.isArray(list) && list.length > 0) {
        clearTimeout(timeoutId);
        const entry = list[0];
        entry._attempt = attempt;
        return entry;
      }
      if (attempt < 3) {
        console.log("[call-completed] enrichment retry " + attempt + "/3: no results");
      }
    }
    clearTimeout(timeoutId);
    console.log("[call-completed] enrichment fetch fail: no results");
    return null;
  } catch (e) {
    clearTimeout(timeoutId);
    const msg = e?.name === "AbortError" ? "timeout (" + timeoutMs + "ms)" : (e?.message ?? String(e));
    console.log("[call-completed] enrichment fetch fail: " + msg);
    return null;
  }
}

/**
 * Map Convoso call_type to Forth call_type. Returns "Incoming" | "Outgoing" | null (omit from payload if null).
 */
function convosoCallTypeToForth(callType) {
  const t = String(callType ?? "").toUpperCase().trim();
  if (t === "INBOUND") return "Incoming";
  if (t === "OUTBOUND" || t === "MANUAL") return "Outgoing";
  return null;
}

/**
 * Direction prefix for notes: Incoming, Outgoing, or MISSING when call_type not sent.
 * Strip any existing "Direction: ... | " from notesBody to avoid stacking.
 */
function applyDirectionPrefix(notesBody, direction) {
  const stripped = String(notesBody ?? "").replace(/^Direction:\s*[^|]*\s*\|\s*/i, "").trim();
  const prefix = direction === "Incoming"
    ? "Direction: Incoming | "
    : direction === "Outgoing"
      ? "Direction: Outgoing | "
      : "Direction: MISSING (Convoso did not send call_type) | ";
  return prefix + (stripped || "");
}

async function forthCreateCall(payload) {
  const url = `${FORTH_BASE_URL}/v1/calls`;
  const r = await forthFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const j = await r.json();
  return { status: r.status, body: j };
}

async function forthCreateContactNote(contactId, content) {
  const url = `${FORTH_BASE_URL}/v1/contacts/${encodeURIComponent(contactId)}/notes`;
  const r = await forthFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: String(content), note_type: 1, public: true })
  });
  const j = await r.json();
  return { status: r.status, body: j };
}

// Health check
app.get("/health", (req, res) => res.json({ ok: true }));

/**
 * Convoso -> Forth
 * Create 1 log on Call Completed
 */
app.post("/convoso/call-completed", async (req, res) => {
  if (!requireSecret(req, res)) return;

  try {
    // You’ll map these fields from Convoso later. For now we accept flexible keys.
    const convoso = normalizeIncomingPayload(req);
    logConvosoRequest("call-completed", convoso);
    console.log("[call-completed] input=" + (convoso._inputType || "unknown") + " payload_keys=" + JSON.stringify(Object.keys(convoso).sort()));
    const phone = convoso.phone;
    if (!phone) return res.status(400).json({ ok: false, error: "Missing phone" });

    if (process.env.CONVOSO_AUTH_TOKEN) {
      const last4 = phone.length >= 4 ? phone.slice(-4) : "????";
      console.log("[call-completed] enrichment fetching convoso for phone_last4=" + last4);
    }
    const convosoLog = await fetchConvosoCallLog(phone);
    let direction;
    let notes;
    let outcome;
    if (convosoLog) {
      direction = convosoCallTypeToForth(convosoLog.call_type);
      const agentComment = String(convosoLog.agent_comment ?? "").trim();
      const baseNote = agentComment || "No Agent Note - Convoso call logged automatically (Call Completed).";
      const logId = convosoLog.id ?? "";
      const statusName = String(convosoLog.status_name ?? "").trim();
      const termReason = String(convosoLog.term_reason ?? "").trim();
      const callLength = convosoLog.call_length ?? convosoLog.call_length_seconds ?? "";
      const notesBody = baseNote + " | ConvosoLogID:" + logId + " | Status:" + statusName + " | Term:" + termReason + " | Len:" + callLength + "s";
      notes = applyDirectionPrefix(notesBody, direction);
      outcome = mapCallCompletedOutcome({ ...convoso, term_reason: convosoLog.term_reason, status_name: convosoLog.status_name, talk_time: convosoLog.call_length ?? convosoLog.call_length_seconds });
      console.log("[call-completed] enrichment ok (attempt " + (convosoLog._attempt || 1) + ") call_type=" + (convosoLog.call_type ?? "") + " convoso_log_id=" + logId);
    } else {
      direction = convosoCallTypeToForth(convoso.call_type);
      const rawNote = (convoso.notes ?? convoso.params?.notes ?? convoso.note ?? convoso.comments ?? convoso.call_notes ?? "").toString().trim();
      const notesBody = rawNote || "No Agent Note - Convoso call logged automatically (Call Completed).";
      notes = applyDirectionPrefix(notesBody, direction);
      outcome = mapCallCompletedOutcome(convoso);
      if (rawNote) {
        console.log("[call-completed] Using agent note (len=" + rawNote.length + ")");
      } else {
        console.log("[call-completed] No agent note found; using fallback");
      }
    }

    const dispId = outcome.dispId;
    const callResult = outcome.call_result;
    console.log("[call-completed] call_result=" + callResult + " (source=" + outcome.source + ")");

    const search = await forthSearchContactByPhone(phone);
    const contact = search?.body?.response?.[0];
    if (!contact?.id) return res.status(200).json({ ok: true, skipped: "No matching contact in Forth" });

    const directionMissing = direction != null ? false : true;

    if (directionMissing) {
      const callLogId = convoso.call_log_id ?? convosoLog?.id ?? "";
      const callDate = convoso.created_at ?? convoso.call_end_time ?? convosoLog?.call_date ?? convosoLog?.call_date_time ?? "";
      const durationSec = Number(convosoLog?.call_length ?? convosoLog?.call_length_seconds ?? convoso.duration ?? convoso.duration_seconds ?? 0);
      const rawNote = (convoso.notes ?? convoso.params?.notes ?? convoso.note ?? convoso.comments ?? convoso.call_notes ?? convosoLog?.agent_comment ?? "").toString().trim();
      const agentNote = rawNote || "No Agent Note - Convoso call logged automatically (Call Completed).";
      const parts = [
        "⚠️ Direction MISSING (Convoso did not send call_type). Call was NOT logged as a Call in Forth because call_type is required.",
        callLogId ? "call_log_id:" + callLogId : "",
        callDate ? "call_date:" + callDate : "",
        durationSec ? "duration:" + durationSec + "s" : "",
        phone ? "phone_number:" + phone : ""
      ].filter(Boolean);
      const noteContent = parts.join(" | ") + " | " + agentNote;
      console.log("[call-completed] direction missing, creating Forth contact note instead of call");
      const create = await forthCreateContactNote(contact.id, noteContent);
      return res.status(200).json({
        ok: true,
        forth: { status: create.status, code: create.body?.status?.code ?? create.status, ...create.body }
      });
    }

    const createdAt = convoso.created_at || convoso.call_end_time || (convosoLog?.call_date ?? convosoLog?.call_date_time) || new Date().toISOString().slice(0, 19).replace("T", " ");

    const durationSec = Number(convosoLog?.call_length ?? convosoLog?.call_length_seconds ?? convoso.duration ?? convoso.duration_seconds ?? 0);
    const hh = String(Math.floor(durationSec / 3600)).padStart(2, "0");
    const mm = String(Math.floor((durationSec % 3600) / 60)).padStart(2, "0");
    const ss = String(durationSec % 60).padStart(2, "0");
    const duration = `${hh}:${mm}:${ss}`;

    const create = await forthCreateCall({
      contactID: Number(contact.id),
      created_at: createdAt,
      call_type: direction,
      call_disposition: dispId,
      call_result: callResult,
      notes,
      duration,
      event_id: 0,
      ...(convoso.recording_url ?? convosoLog?.recording_url ? { recording_url: convoso.recording_url || convosoLog?.recording_url } : {})
    });

    return res.status(200).json({ ok: true, forth: create.body });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

/**
 * POST /convoso/disposition — first disposition only; dedupe gate BEFORE any Forth lookup.
 */
app.post("/convoso/disposition", async (req, res) => {
  if (!requireSecret(req, res)) return;

  try {
    const convoso = parseConvosoBody(req);
    const disposition = (convoso.disposition ?? convoso.disposition_name ?? "").toString().trim();
    if (!disposition) return res.status(200).json({ ok: true, skipped: "Disposition blank" });

    const callId = convoso.call_id != null ? String(convoso.call_id) : null;
    const leadId = convoso.lead_id != null ? String(convoso.lead_id) : "";
    const callStartTs = convoso.call_start_time ?? convoso.start_time ?? convoso.created_at ?? "";
    const timestamp = callStartTs || String(Date.now());
    const dedupeKey = callId ? `disp_first_set:${callId}` : `disp_first_set:${leadId}:${timestamp}`;

    pruneFirstDispositionSeen();
    if (firstDispositionSeen.has(dedupeKey)) {
      return res.status(200).json({ ok: true, skipped: "Disposition already processed", deduped: true });
    }

    // Set immediately so second request returns deduped before any Forth lookup
    firstDispositionSeen.set(dedupeKey, {
      ts: Date.now(),
      disposition_id: convoso.disposition_id ?? convoso.id ?? ""
    });

    const phone = convoso.phone;
    if (!phone) return res.status(400).json({ ok: false, error: "Missing phone" });

    const search = await forthSearchContactByPhone(phone);
    const contact = search?.body?.response?.[0];
    if (!contact?.id) return res.status(200).json({ ok: true, skipped: "No matching contact in Forth" });

    const direction = (convoso.direction || convoso.call_type || "Incoming").toLowerCase().includes("out")
      ? "Outgoing"
      : "Incoming";

    const dispId =
      /no answer|na/i.test(disposition) ? DISP.NO_ANSWER :
      /busy/i.test(disposition) ? DISP.BUSY :
      /left|vm|voicemail|message/i.test(disposition) ? DISP.LEFT_MESSAGE :
      DISP.CONNECTED;

    const createdAt = convoso.created_at || new Date().toISOString().slice(0, 19).replace("T", " ");
    const notes = `Convoso - Disposition: ${disposition} | phone=${phone}`;

    await forthCreateCall({
      contactID: Number(contact.id),
      created_at: createdAt,
      call_type: direction,
      call_disposition: dispId,
      notes,
      duration: "00:00:00",
      event_id: 0,
      ...(convoso.recording_url ? { recording_url: convoso.recording_url } : {})
    });

    return res.status(200).json({ ok: true, created: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

/**
 * Convoso -> Forth
 * Create 1 log on Disposition Set (only once when first set)
 * We rely on Convoso config to only fire when blank -> value (your choice).
 */
app.post("/convoso/disposition-set", async (req, res) => {
  if (!requireSecret(req, res)) return;

  try {
    const rawPhone = req.body.phone || req.body.phone_number || req.body.caller_id || req.body.lead_phone;
    const phone = normalizePhone(rawPhone);
    if (!phone) return res.status(400).json({ ok: false, error: "Missing phone" });

    const search = await forthSearchContactByPhone(phone);
    const contact = search?.body?.response?.[0];
    if (!contact?.id) return res.status(200).json({ ok: true, skipped: "No matching contact in Forth" });

    const direction = (req.body.direction || req.body.call_type || "Incoming").toLowerCase().includes("out")
      ? "Outgoing"
      : "Incoming";

    const convosoDisp = String(req.body.disposition || req.body.disposition_name || "Connected").trim();

    // Map disposition names simply (you can expand later)
    const dispId =
      /no answer|na/i.test(convosoDisp) ? DISP.NO_ANSWER :
      /busy/i.test(convosoDisp) ? DISP.BUSY :
      /left|vm|voicemail|message/i.test(convosoDisp) ? DISP.LEFT_MESSAGE :
      DISP.CONNECTED;

    const createdAt = req.body.created_at || new Date().toISOString().slice(0, 19).replace("T", " ");
    const notes = `Convoso - Disposition Set: ${convosoDisp} | phone=${phone}`;

    const create = await forthCreateCall({
      contactID: Number(contact.id),
      created_at: createdAt,
      call_type: direction,
      call_disposition: dispId,
      notes,
      duration: "00:00:00",
      event_id: 0,
      ...(req.body.recording_url ? { recording_url: req.body.recording_url } : {})
    });

    return res.status(200).json({ ok: true, forth: create.body });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

const port = process.env.PORT || 3000;
if (process.env.FORTH_KEY_ID && process.env.FORTH_API_SECRET) {
  refreshForthAccessToken().catch((e) => console.log("[forth-auth] startup refresh failed: " + (e?.message ?? String(e))));
  setInterval(() => {
    refreshForthAccessToken().catch((e) => console.log("[forth-auth] scheduled refresh failed: " + (e?.message ?? String(e))));
  }, 9 * 24 * 60 * 60 * 1000);
}
app.listen(port, () => console.log(`Listening on ${port}`));
