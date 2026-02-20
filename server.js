const express = require("express");
const querystring = require("querystring");

const app = express();
app.use(express.json({ limit: "1mb" }));

/**
 * ENV VARS you will set in Render:
 * FORTH_API_KEY = the api_key you obtained from /v1/auth/token
 * FORTH_BASE_URL = https://api.forthcrm.com
 * SHARED_SECRET = a random string you will also put in Convoso (as a header value)
 */
const FORTH_API_KEY = process.env.FORTH_API_KEY;
const FORTH_BASE_URL = process.env.FORTH_BASE_URL || "https://api.forthcrm.com";
const SHARED_SECRET = process.env.SHARED_SECRET;

// Minimal disposition mapping (you can expand later)
const DISP = {
  NO_ANSWER: 1,
  CONNECTED: 2,
  LEFT_MESSAGE: 3,
  BUSY: 6
};

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
 * Returns { ...parsedFields, phone } where phone is normalized for lookup (digits).
 */
function parseConvosoBody(req) {
  const body = req.body || {};
  if (typeof body.params === "string") {
    const parsed = querystring.parse(body.params);
    const phoneNumber = parsed.phone_number ?? parsed.phone ?? "";
    const phoneCode = String(parsed.phone_code ?? "").trim();
    const digits = normalizePhone(phoneNumber);
    const normalizedPhone = digits;
    const phoneE164 = phoneCode && digits ? `+${phoneCode}${digits}` : null;
    const convoso = { ...parsed, phone: normalizedPhone, phone_number: phoneNumber, phone_code: phoneCode, phoneE164 };
    console.log("[convoso] input=params", convoso.call_id != null ? `call_id=${convoso.call_id}` : "", convoso.lead_id != null ? `lead_id=${convoso.lead_id}` : "");
    return convoso;
  }
  const rawPhone = body.phone || body.phone_number || body.caller_id || body.lead_phone;
  const convoso = { ...body, phone: normalizePhone(rawPhone) };
  console.log("[convoso] input=json", convoso.call_id != null ? `call_id=${convoso.call_id}` : "", convoso.lead_id != null ? `lead_id=${convoso.lead_id}` : "");
  return convoso;
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
    const phone = convoso.phone;
    if (!phone) return res.status(400).json({ ok: false, error: "Missing phone" });

    const direction = (convoso.direction || convoso.call_type || "Incoming").toLowerCase().includes("out")
      ? "Outgoing"
      : "Incoming";

    const search = await forthSearchContactByPhone(phone);
    const contact = search?.body?.response?.[0];
    if (!contact?.id) return res.status(200).json({ ok: true, skipped: "No matching contact in Forth" });

    // Simple heuristic for disposition at call end:
    const talkSec = Number(convoso.talk_time || convoso.talk_seconds || 0);
    const dispId = talkSec > 0 ? DISP.CONNECTED : DISP.NO_ANSWER;

    const createdAt = convoso.created_at || convoso.call_end_time || new Date().toISOString().slice(0, 19).replace("T", " ");

    const durationSec = Number(convoso.duration || convoso.duration_seconds || 0);
    const hh = String(Math.floor(durationSec / 3600)).padStart(2, "0");
    const mm = String(Math.floor((durationSec % 3600) / 60)).padStart(2, "0");
    const ss = String(durationSec % 60).padStart(2, "0");
    const duration = `${hh}:${mm}:${ss}`;

    const notes = `Convoso - Call Completed | phone=${phone}`;

    const create = await forthCreateCall({
      contactID: Number(contact.id),
      created_at: createdAt,
      call_type: direction,
      call_disposition: dispId,
      notes,
      duration,
      event_id: 0,
      ...(convoso.recording_url ? { recording_url: convoso.recording_url } : {})
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
