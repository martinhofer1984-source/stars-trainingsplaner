// Cloud Functions for the Stars Trainingsplaner: push notifications and the waiting list.
//
// Every notification for the whole team is written as a document into "news" (shown in the
// Team-Info tab); onNews sends it as a push message to all registered devices ("tokens").
// Messages for single players or the trainers (deadline reminder, waiting list, material,
// late absences, open amounts) are only pushed, not kept in the feed.
const { onDocumentCreated, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { setGlobalOptions, logger } = require("firebase-functions/v2");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, Timestamp } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");
const { cleanupNews } = require("./cleanup");
const core = require("./core");

initializeApp();
setGlobalOptions({ region: "europe-west1", maxInstances: 2 });
const db = getFirestore();

const APP_URL = "https://stars-trainingsplaner.firebaseapp.com/";
const TZ = "Europe/Rome";
const DEADLINE_MS = core.DEADLINE_MS;     // players answer up to 24 h before the start
const REMIND_BEFORE_MS = 3 * 3600e3;      // reminder up to 3 h before the deadline
const REASON = { krank: "krank", urlaub: "Urlaub", sonstiges: "abwesend" };

const ms = v => (v && typeof v.toMillis === "function") ? v.toMillis() : (Number.isFinite(v) ? v : 0);
const kindOf = t => t.kind === "game" ? "Spiel" : "Training";
const day = m => new Intl.DateTimeFormat("de-DE", { timeZone: TZ, weekday: "short", day: "2-digit", month: "2-digit" }).format(m).replace(",", "");
const time = m => new Intl.DateTimeFormat("de-DE", { timeZone: TZ, hour: "2-digit", minute: "2-digit" }).format(m);
const when = t => `${day(ms(t.start))} um ${time(ms(t.start))} Uhr${t.place ? " – " + t.place : ""}`;
const euro = n => new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" }).format(n);
const isTeams = x => !!x && Array.isArray(x.A) && Array.isArray(x.B);
const isLines = x => !!x && typeof x.slot === "object" && x.slot !== null;
const isTrainerMember = m => ["trainer", "developer"].includes(m.role || "trainer");
const plainTraining = (id, t) => ({ ...t, id, start: ms(t.start), responses: t.responses || {} });

// Sends one message to the given devices and removes tokens that are no longer valid
async function pushTokens(tokens, { title, body, link = "#training", tag }) {
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
const pushAll = async msg => pushTokens((await db.collection("tokens").get()).docs.map(d => d.id), msg);

// Devices of the members that match (member data, e-mail), grouped by player id
async function tokensOf(match) {
  const [members, tokens] = await Promise.all([db.collection("members").get(), db.collection("tokens").get()]);
  const owner = new Map();
  members.forEach(m => { if (match(m.data(), m.id)) owner.set(m.id, m.data().playerId || m.id); });
  const out = new Map();
  tokens.forEach(t => {
    const key = owner.get(String(t.data().email || "").toLowerCase());
    if (key !== undefined) out.set(key, [...(out.get(key) || []), t.id]);
  });
  return out;
}
const pushPlayers = async (pids, msg) => pushTokens([...(await tokensOf(m => pids.includes(m.playerId))).values()].flat(), msg);
const pushTrainers = async msg => pushTokens([...(await tokensOf(isTrainerMember)).values()].flat(), msg);
const nameOf = async pid => (await db.collection("roster").doc(pid).get()).data()?.name || "Ein Spieler";

// Writes an automatic entry into the Team-Info feed; onNews pushes it. tid links it to the
// appointment, so the entry disappears once the appointment is over; until removes it at that time.
const post = (title, text, link, tag, tid, until) =>
  db.collection("news").add({ title, text, link, ...(tag ? { tag } : {}), ...(tid ? { tid } : {}), ...(until ? { until } : {}), at: Timestamp.now(), by: "App", kind: "event" });

exports.onNews = onDocumentCreated("news/{id}", async event => {
  const n = event.data?.data(); if (!n) return;
  const body = n.kind === "poll" ? `${n.text ? n.text + " – " : ""}Jetzt abstimmen: ${(n.options || []).join(" / ")}` : n.text;
  await pushAll({ title: n.kind === "poll" ? "Umfrage: " + n.title : n.title, body, link: n.link || "#info", tag: n.tag });
});

exports.onTrainingCreated = onDocumentCreated("trainings/{id}", async event => {
  const t = event.data?.data(); if (!t || t.cancelled || t.bulk || ms(t.start) < Date.now()) return;   // bulk: announced by one message from the import
  await post(`Neuer Termin: ${kindOf(t)}`, `${when(t)}. Du bist automatisch dabei – absagen bis 24 Stunden vorher.`, "#training", "t-" + event.params.id, event.params.id);
});

// ---------- waiting list ----------
async function loadAttendance() {
  const [r, a] = await Promise.all([db.collection("roster").get(), db.collection("absences").get()]);
  const roster = {}; r.forEach(x => { roster[x.id] = x.data(); });
  const absences = a.docs.map(x => ({ ...x.data(), id: x.id, at: ms(x.data().at) }));
  return { roster, absences };
}
// Brings the waiting list of an appointment up to date and tells the players who moved up
async function syncWait(id, before, after) {
  if (!after || after.cancelled || ms(after.start) <= Date.now()) return;
  const d = await loadAttendance();
  const t = plainTraining(id, after);
  const { wait, promoted } = core.waitUpdate(d, before ? plainTraining(id, before) : null, t);
  const old = core.waitOf(t);
  if (wait.length === old.length && wait.every((p, i) => p === old[i])) return;
  await db.collection("trainings").doc(id).update({ wait });
  if (promoted.length) await pushPlayers(promoted, { title: "Du bist nachgerückt", body: `${kindOf(after)} ${when(after)}: Ein Platz ist frei geworden – du bist jetzt dabei.`, link: "#training", tag: "wait-" + id });
  const joined = wait.filter(p => !old.includes(p));
  if (joined.length) await pushPlayers(joined, { title: "Warteliste", body: `${kindOf(after)} ${when(after)} ist voll – du stehst auf der Warteliste und rückst automatisch nach, sobald ein Platz frei wird.`, link: "#training", tag: "wait-" + id });
}

// ---------- material ----------
async function materialPush(id, b, a) {
  const mb = b.material || {}, ma = a.material || {};
  if (ma.pid && ma.state === "asked" && (mb.pid !== ma.pid || mb.state !== "asked"))
    return pushPlayers([ma.pid], { title: "Kannst du das Material mitnehmen?", body: `${kindOf(a)} ${when(a)}: Bitte in der App zusagen oder absagen.`, link: "#training", tag: "mat-" + id });
  if (ma.pid && mb.pid === ma.pid && mb.state === "asked" && (ma.state === "yes" || ma.state === "no")) {
    const name = await nameOf(ma.pid);
    return pushTrainers(ma.state === "yes"
      ? { title: "Material ist organisiert", body: `${name} nimmt das Material mit (${kindOf(a)} ${when(a)}).`, link: "#training", tag: "mat-" + id }
      : { title: "Material: Absage", body: `${name} kann das Material nicht mitnehmen (${kindOf(a)} ${when(a)}). Bitte jemand anderen fragen.`, link: "#training", tag: "mat-" + id });
  }
}

exports.onTrainingUpdated = onDocumentUpdated("trainings/{id}", async event => {
  const b = event.data?.before?.data(), a = event.data?.after?.data(); if (!b || !a) return;
  if (ms(a.start) + 3 * 3600e3 < Date.now()) return;   // past appointments (results, no-shows) stay quiet
  const id = event.params.id;
  try { await materialPush(id, b, a); } catch (e) { logger.error("material push failed", e); }
  try { await syncWait(id, b, a); } catch (e) { logger.error("waiting list failed", e); }
  if (!b.cancelled && a.cancelled) return post(`${kindOf(a)} fällt aus`, `${when(a)} fällt aus.`, "#training", "t-" + id, id);
  if (b.cancelled && !a.cancelled) return post(`${kindOf(a)} findet doch statt`, `${when(a)} findet doch statt.`, "#training", "t-" + id, id);
  if (a.cancelled) return;
  if (isTeams(a.teams) && (!isTeams(b.teams) || a.teams.at !== b.teams.at))
    return post(isTeams(b.teams) ? "Teams geändert" : "Teams sind eingeteilt", `${kindOf(a)} ${when(a)}: Schau nach, in welchem Team du spielst.`, "#training", "teams-" + id, id);
  if (isLines(a.lines) && (!isLines(b.lines) || a.lines.at !== b.lines.at))
    return post(isLines(b.lines) ? "Linien geändert" : "Linien sind eingeteilt", `${kindOf(a)} ${when(a)}: Schau nach, in welcher Linie du spielst.`, "#training", "lines-" + id, id);
});

// ---------- absences ----------
// Coming appointments within the period of an absence
const absenceTrainings = async a => (await db.collection("trainings")
  .where("start", ">=", Timestamp.fromMillis(Math.max(ms(a.from), Date.now())))
  .where("start", "<=", Timestamp.fromMillis(ms(a.to))).get()).docs;

// A report after an appointment's deadline needs a trainer: tell the trainers right away.
// Every absence can free places, so the waiting lists move up.
exports.onAbsenceCreated = onDocumentCreated("absences/{id}", async event => {
  const a = event.data?.data(); if (!a) return;
  const at = ms(a.at) || Date.now(), docs = await absenceTrainings(a);
  const late = docs.map(x => x.data()).filter(t => !t.cancelled && at >= ms(t.start) - DEADLINE_MS);
  if (!a.byTrainer && late.length) {
    const name = await nameOf(a.pid);
    await pushTrainers({ title: `${name} meldet sich kurzfristig ab`, body: `${REASON[a.reason] || "abwesend"}${a.note ? " (" + a.note + ")" : ""}: ${late.map(t => `${kindOf(t)} ${when(t)}`).join(", ")}. Bitte in der App bestätigen.`, link: "#training", tag: "abs-" + event.params.id });
  }
  for (const x of docs) { try { await syncWait(x.id, null, x.data()); } catch (e) { logger.error("waiting list failed", e); } }
});
exports.onAbsenceUpdated = onDocumentUpdated("absences/{id}", async event => {
  const a = event.data?.after?.data(); if (!a) return;
  for (const x of await absenceTrainings(a)) { try { await syncWait(x.id, null, x.data()); } catch (e) { logger.error("waiting list failed", e); } }
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

// Fridays at noon: every player with an open amount gets a reminder with the amount
exports.paymentReminder = onSchedule({ schedule: "0 12 * * 5", timeZone: TZ }, async () => {
  const all = c => db.collection(c).get();
  const [roster, absences, trainings, billing, fines, kasse] = await Promise.all([
    all("roster"), all("absences"), all("trainings"), all("billing"), all("fines"), db.collection("kasse").doc("settings").get()]);
  const d = { roster: {}, billing: {}, kasse: kasse.exists ? kasse.data() : null };
  roster.forEach(x => { d.roster[x.id] = x.data(); });
  billing.forEach(x => { d.billing[x.id] = x.data(); });
  d.absences = absences.docs.map(x => ({ ...x.data(), id: x.id, at: ms(x.data().at) }));
  d.trainings = trainings.docs.map(x => plainTraining(x.id, x.data()));
  d.fines = fines.docs.map(x => ({ ...x.data(), id: x.id }));
  const devices = await tokensOf(m => !!m.playerId);
  let sent = 0;
  for (const [pid, tokens] of devices) {
    if (!d.roster[pid]) continue;
    const open = Math.round(core.openOf(d, pid) * 100) / 100;
    if (open < 0.01) continue;
    await pushTokens(tokens, { title: "Offener Betrag in der Kasse", body: `Offen: ${euro(open)} – bitte beim Kassier begleichen. Details in der App unter Konto.`, link: "#konto", tag: "pay" });
    sent++;
  }
  logger.info(`payment reminder: ${sent} players`);
});

// Every morning: birthday greetings in the Team-Info (gone at the end of the day)
exports.birthdays = onSchedule({ schedule: "0 8 * * *", timeZone: TZ }, async () => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date()).map(p => [p.type, p.value]));
  const today = `${parts.month}-${parts.day}`, y = +parts.year;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const days = today === "02-28" && !leap ? ["02-28", "02-29"] : [today];   // 29 February: on the 28th in other years
  const snap = await db.collection("profiles").where("birthday", "in", days).get();
  const until = Timestamp.fromMillis(Date.now() + 16 * 3600e3);
  for (const p of snap.docs) {
    const r = (await db.collection("roster").doc(p.id).get()).data();
    if (!r || r.active === false) continue;
    await post("Geburtstag 🎂", `${r.name} hat heute Geburtstag – alles Gute!`, "#info", `bday-${p.id}-${today}`, null, until);
  }
});
