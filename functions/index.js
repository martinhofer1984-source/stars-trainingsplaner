// Cloud Functions for the Stars Trainingsplaner: push notifications.
//
// Every notification is written as a document into "news" (shown in the Team-Info tab);
// onNews sends it as a push message to all registered devices ("tokens").
// Exception: the reminder before the answer deadline is only pushed, not kept in the feed.
const { onDocumentCreated, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { setGlobalOptions, logger } = require("firebase-functions/v2");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, Timestamp } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");
const { cleanupNews } = require("./cleanup");

initializeApp();
setGlobalOptions({ region: "europe-west1", maxInstances: 2 });
const db = getFirestore();

const APP_URL = "https://stars-trainingsplaner.firebaseapp.com/";
const TZ = "Europe/Rome";
const DEADLINE_MS = 24 * 3600e3;          // players answer up to 24 h before the start
const REMIND_BEFORE_MS = 3 * 3600e3;      // reminder up to 3 h before the deadline

const ms = v => (v && typeof v.toMillis === "function") ? v.toMillis() : 0;
const kindOf = t => t.kind === "game" ? "Spiel" : "Training";
const day = m => new Intl.DateTimeFormat("de-DE", { timeZone: TZ, weekday: "short", day: "2-digit", month: "2-digit" }).format(m).replace(",", "");
const time = m => new Intl.DateTimeFormat("de-DE", { timeZone: TZ, hour: "2-digit", minute: "2-digit" }).format(m);
const when = t => `${day(ms(t.start))} um ${time(ms(t.start))} Uhr${t.place ? " – " + t.place : ""}`;
const isTeams = x => !!x && Array.isArray(x.A) && Array.isArray(x.B);
const isLines = x => !!x && typeof x.slot === "object" && x.slot !== null;

// Sends one message to all registered devices and removes tokens that are no longer valid
async function pushAll({ title, body, link = "#training", tag }) {
  const snap = await db.collection("tokens").get();
  const tokens = snap.docs.map(d => d.id);
  if (!tokens.length) return;
  const data = { title: String(title), body: String(body || ""), link: APP_URL + link, ...(tag ? { tag } : {}) };
  for (let i = 0; i < tokens.length; i += 500) {
    const chunk = tokens.slice(i, i + 500);
    const res = await getMessaging().sendEachForMulticast({ tokens: chunk, data, webpush: { headers: { Urgency: "high", TTL: "86400" } } });
    const dead = [];
    res.responses.forEach((r, j) => {
      const code = r.error?.code || "";
      if (code.includes("registration-token-not-registered") || code.includes("invalid-registration-token") || code.includes("invalid-argument")) dead.push(chunk[j]);
    });
    await Promise.all(dead.map(t => db.collection("tokens").doc(t).delete()));
    logger.info(`push "${title}": ${res.successCount} sent, ${res.failureCount} failed, ${dead.length} tokens removed`);
  }
}

// Writes an automatic entry into the Team-Info feed; onNews pushes it. tid links it to the
// appointment, so the entry disappears once the appointment is over.
const post = (title, text, link, tag, tid) =>
  db.collection("news").add({ title, text, link, ...(tag ? { tag } : {}), ...(tid ? { tid } : {}), at: Timestamp.now(), by: "App", kind: "event" });

exports.onNews = onDocumentCreated("news/{id}", async event => {
  const n = event.data?.data(); if (!n) return;
  await pushAll({ title: n.title, body: n.text, link: n.link || "#info", tag: n.tag });
});

exports.onTrainingCreated = onDocumentCreated("trainings/{id}", async event => {
  const t = event.data?.data(); if (!t || t.cancelled || ms(t.start) < Date.now()) return;
  await post(`Neuer Termin: ${kindOf(t)}`, `${when(t)}. Du bist automatisch dabei – absagen bis 24 Stunden vorher.`, "#training", "t-" + event.params.id, event.params.id);
});

exports.onTrainingUpdated = onDocumentUpdated("trainings/{id}", async event => {
  const b = event.data?.before?.data(), a = event.data?.after?.data(); if (!b || !a) return;
  if (ms(a.start) + 3 * 3600e3 < Date.now()) return;   // past appointments (results, no-shows) stay quiet
  const id = event.params.id;
  if (!b.cancelled && a.cancelled) return post(`${kindOf(a)} fällt aus`, `${when(a)} fällt aus.`, "#training", "t-" + id, id);
  if (b.cancelled && !a.cancelled) return post(`${kindOf(a)} findet doch statt`, `${when(a)} findet doch statt.`, "#training", "t-" + id, id);
  if (a.cancelled) return;
  if (isTeams(a.teams) && (!isTeams(b.teams) || a.teams.at !== b.teams.at))
    return post(isTeams(b.teams) ? "Teams geändert" : "Teams sind eingeteilt", `${kindOf(a)} ${when(a)}: Schau nach, in welchem Team du spielst.`, "#training", "teams-" + id, id);
  if (isLines(a.lines) && (!isLines(b.lines) || a.lines.at !== b.lines.at))
    return post(isLines(b.lines) ? "Linien geändert" : "Linien sind eingeteilt", `${kindOf(a)} ${when(a)}: Schau nach, in welcher Linie du spielst.`, "#training", "lines-" + id, id);
});

// Every 15 minutes: remind once when the answer deadline ends within the next 3 hours
exports.deadlineReminder = onSchedule({ schedule: "every 15 minutes", timeZone: TZ }, async () => {
  const now = Date.now();
  // Tidy up the Team-Info feed (see cleanup.js)
  try { const n = await cleanupNews(db, now); if (n) logger.info(`team info: ${n} old entries removed`); }
  catch (e) { logger.error("team info cleanup failed", e); }
  const snap = await db.collection("trainings")
    .where("start", ">", Timestamp.fromMillis(now + DEADLINE_MS))
    .where("start", "<=", Timestamp.fromMillis(now + DEADLINE_MS + REMIND_BEFORE_MS)).get();
  for (const d of snap.docs) {
    const t = d.data(); if (t.cancelled) continue;
    const mark = db.collection("pushlog").doc("reminder-" + d.id);
    const fresh = await db.runTransaction(async tx => {
      if ((await tx.get(mark)).exists) return false;
      tx.set(mark, { at: Timestamp.now() }); return true;
    });
    if (!fresh) continue;
    const deadline = ms(t.start) - DEADLINE_MS;
    await pushAll({
      title: `Erinnerung: ${kindOf(t)} ${day(ms(t.start))}`,
      body: `${when(t)}. Du bist dabei, außer du sagst bis ${time(deadline)} Uhr ab.`,
      link: "#training", tag: "remind-" + d.id,
    });
  }
});
