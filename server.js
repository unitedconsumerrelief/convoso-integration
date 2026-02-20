const express = require("express");
const querystring = require("querystring");

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

/**
 * ENV VARS you will set in Render:
 * FORTH_API_KEY = the api_key you obtained from /v1/auth/token
 * FORTH_BASE_URL = https://api.forthcrm.com
 * SHARED_SECRET = a random string you will also put in Convoso (as a header value)
 * CONVOSO_AUTH_TOKEN = Convoso API auth token for Call Log Retrieve
 */
const FORTH_API_KEY = process.env.FORTH_API_KEY;
const FORTH_BASE_URL = process.env.FORTH_BASE_URL || "https://api.forthcrm.com";
const SHARED_SECRET = process.env.SHARED_SECRET;
const CONVOSO_AUTH_TOKEN = process.env.CONVOSO_AUTH_TOKEN;
const CONVOSO_API_BASE = "https://api.convoso.com";

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

async function forthSearchContactByPhone(phone) {
  const url = `${FORTH_BASE_URL}/v1/contacts/search_by_phone/${encodeURIComponent(phone)}`;
  const r = await fetch(url, {
    method: "GET",
    headers: { "Api-Key": FORTH_API_KEY }
  });
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
 * Fetch Convoso Call Log for phone; returns best matching log entry or null on failure/no data.
 * Uses process.env.CONVOSO_AUTH_TOKEN at request time.
 */
async function fetchConvosoCallLog(phone) {
  const authToken = process.env.CONVOSO_AUTH_TOKEN;
  if (!authToken || !authToken.trim()) {
    console.log("[call-completed] enrichment skipped: missing CONVOSO_AUTH_TOKEN");
    return null;
  }
  if (!phone) return null;
  const now = new Date();
  const start = new Date(now.getTime() - 10 * 60 * 1000);
  const end = new Date(now.getTime() + 2 * 60 * 1000);
  const params = new URLSearchParams({
    auth_token: authToken,
    phone_number: String(phone),
    start_time: formatConvosoTime(start),
    end_time: formatConvosoTime(end),
    order: "desc",
    limit: "3",
    include_recordings: "0"
  });
  const url = `${CONVOSO_API_BASE}/v1/log/retrieve?${params.toString()}`;
  const timeoutMs = 8000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, { method: "GET", signal: controller.signal });
    clearTimeout(timeoutId);
    const j = await r.json();
    if (!r.ok) {
      console.log("[call-completed] enrichment fetch fail: HTTP " + r.status + " " + (j?.message ?? j?.error ?? ""));
      return null;
    }
    const list = j?.data ?? j?.logs ?? Array.isArray(j) ? j : [];
    if (!Array.isArray(list) || list.length === 0) {
      console.log("[call-completed] enrichment fetch fail: no results");
      return null;
    }
    const nowTs = now.getTime();
    const withDiff = list.map((entry) => {
      const dateStr = entry.call_date ?? entry.call_date_time ?? entry.date ?? "";
      const entryTs = dateStr ? new Date(dateStr).getTime() : 0;
      return { entry, diff: Math.abs(nowTs - entryTs) };
    });
    withDiff.sort((a, b) => a.diff - b.diff);
    return withDiff[0].entry;
  } catch (e) {
    clearTimeout(timeoutId);
    const msg = e?.name === "AbortError" ? "timeout (" + timeoutMs + "ms)" : (e?.message ?? String(e));
    console.log("[call-completed] enrichment fetch fail: " + msg);
    return null;
  }
}

function directionFromConvosoCallType(callType) {
  const t = String(callType ?? "").toUpperCase();
  if (t === "INBOUND") return "INBOUND";
  if (t === "OUTBOUND" || t === "MANUAL") return "OUTBOUND";
  return t || "UNKNOWN";
}

async function forthCreateCall(payload) {
  const url = `${FORTH_BASE_URL}/v1/calls`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Api-Key": FORTH_API_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
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
    const convoso = parseConvosoBody(req);
    logConvosoRequest("call-completed", convoso);
    console.log("[call-completed] payload_keys=" + JSON.stringify(Object.keys(convoso).sort()));
    if (typeof convoso.params === "object" && convoso.params !== null) {
      console.log("[call-completed] params_keys=" + JSON.stringify(Object.keys(convoso.params).sort()));
    }
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
      const dirLabel = directionFromConvosoCallType(convosoLog.call_type);
      direction = dirLabel === "INBOUND" ? "Incoming" : dirLabel === "OUTBOUND" ? "Outgoing" : (convoso.direction || convoso.call_type || "Incoming").toLowerCase().includes("out") ? "Outgoing" : "Incoming";
      const agentComment = String(convosoLog.agent_comment ?? "").trim();
      const baseNote = agentComment || "No Agent Note - Convoso call logged automatically (Call Completed).";
      const logId = convosoLog.id ?? "";
      const statusName = String(convosoLog.status_name ?? "").trim();
      const termReason = String(convosoLog.term_reason ?? "").trim();
      const callLength = convosoLog.call_length ?? convosoLog.call_length_seconds ?? "";
      notes = baseNote + " | Direction: " + dirLabel + " | ConvosoLogID:" + logId + " | Status:" + statusName + " | Term:" + termReason + " | Len:" + callLength + "s";
      outcome = mapCallCompletedOutcome({ ...convoso, term_reason: convosoLog.term_reason, status_name: convosoLog.status_name, talk_time: convosoLog.call_length ?? convosoLog.call_length_seconds });
      console.log("[call-completed] enrichment ok call_type=" + (convosoLog.call_type ?? "") + " convoso_log_id=" + logId);
    } else {
      direction = (convoso.direction || convoso.call_type || "Incoming").toLowerCase().includes("out") ? "Outgoing" : "Incoming";
      const rawNote = (convoso.notes ?? convoso.params?.notes ?? convoso.note ?? convoso.comments ?? convoso.call_notes ?? "").toString().trim();
      notes = rawNote || "No Agent Note - Convoso call logged automatically (Call Completed).";
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
app.listen(port, () => console.log(`Listening on ${port}`));
