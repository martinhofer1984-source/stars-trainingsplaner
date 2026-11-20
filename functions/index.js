// Cloud Functions for the Stars Trainingsplaner: push notifications and the waiting list.
//
// Every notification for the whole team is written as a document into "news" (shown in the
// Team-Info tab); onNews sends it as a push message to all registered devices ("tokens").
// Messages for single players or the trainers (deadline reminder, waiting list, material,
// late absences, open amounts) are only pushed, not kept in the feed.
const { onDocumentCreated, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { setGlobalOptions, logger } = require("firebase-functions/v2");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, Timestamp } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");
const { cleanupNews } = require("./cleanup");
const core = require("./core");

initializeApp();
setGlobalOptions({ region: "europe-west1", maxInstances: 2 });

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

// Everything below runs once for the live database "(default)" and once for the test database
// "test" (function names with "Test" at the end); each copy reads and writes only its own data.
function forDatabase(dbId, suffix) {
const db = dbId === "(default)" ? getFirestore() : getFirestore(dbId);
const on = document => ({ document, database: dbId });
const out = {};

// Sends one message to the given devices and removes tokens that are no longer valid
async function pushTokens(tokens, { title, body, link = "#training", tag }) {
  if (!tokens.length) return;
  if (suffix) title = "TEST: " + title;   // pushes from the test database are marked
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
  db.collection("news").add({ title, text, link: tid ? "#termin-" + tid : link, ...(tag ? { tag } : {}), ...(tid ? { tid } : {}), ...(until ? { until } : {}), at: Timestamp.now(), by: "App", kind: "event" });

out["onNews" + suffix] = onDocumentCreated(on("news/{id}"), async event => {
  const n = event.data?.data(); if (!n) return;
  const body = n.kind === "poll" ? `${n.text ? n.text + " – " : ""}Jetzt abstimmen: ${(n.options || []).join(" / ")}` : n.text;
  await pushAll({ title: n.kind === "poll" ? "Umfrage: " + n.title : n.title, body, link: n.link || "#info", tag: n.tag });
});

out["onTrainingCreated" + suffix] = onDocumentCreated(on("trainings/{id}"), async event => {
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
  if (promoted.length) await pushPlayers(promoted, { title: "Du bist nachgerückt", body: `${kindOf(after)} ${when(after)}: Ein Platz ist frei geworden – du bist jetzt dabei.`, link: "#termin-" + id, tag: "wait-" + id });
  const joined = wait.filter(p => !old.includes(p));
  if (joined.length) await pushPlayers(joined, { title: "Warteliste", body: `${kindOf(after)} ${when(after)} ist voll – du stehst auf der Warteliste und rückst automatisch nach, sobald ein Platz frei wird.`, link: "#termin-" + id, tag: "wait-" + id });
}

// ---------- material ----------
async function materialPush(id, b, a) {
  const mb = b.material || {}, ma = a.material || {};
  if (ma.pid && ma.state === "asked" && (mb.pid !== ma.pid || mb.state !== "asked"))
    return pushPlayers([ma.pid], { title: "Kannst du die Trikots mitnehmen?", body: `${kindOf(a)} ${when(a)}: Bitte in der App zusagen oder absagen.`, link: "#termin-" + id, tag: "mat-" + id });
  if (ma.pid && mb.pid === ma.pid && mb.state === "asked" && (ma.state === "yes" || ma.state === "no")) {
    const name = await nameOf(ma.pid);
    return pushTrainers(ma.state === "yes"
      ? { title: "Trikots sind organisiert", body: `${name} nimmt die Trikots mit (${kindOf(a)} ${when(a)}).`, link: "#termin-" + id, tag: "mat-" + id }
      : { title: "Trikots: Absage", body: `${name} kann die Trikots nicht mitnehmen (${kindOf(a)} ${when(a)}). Bitte jemand anderen fragen.`, link: "#termin-" + id, tag: "mat-" + id });
  }
}

out["onTrainingUpdated" + suffix] = onDocumentUpdated(on("trainings/{id}"), async event => {
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
out["onAbsenceCreated" + suffix] = onDocumentCreated(on("absences/{id}"), async event => {
  const a = event.data?.data(); if (!a) return;
  const at = ms(a.at) || Date.now(), docs = await absenceTrainings(a);
  const lateDocs = docs.filter(x => !x.data().cancelled && at >= ms(x.data().start) - DEADLINE_MS), late = lateDocs.map(x => x.data());
  if (!a.byTrainer && late.length) {
    const name = await nameOf(a.pid);
    await pushTrainers({ title: `${name} meldet sich kurzfristig ab`, body: `${REASON[a.reason] || "abwesend"}${a.note ? " (" + a.note + ")" : ""}: ${late.map(t => `${kindOf(t)} ${when(t)}`).join(", ")}. Bitte in der App bestätigen.`, link: late.length === 1 ? "#termin-" + lateDocs[0].id : "#training", tag: "abs-" + event.params.id });
  }
  for (const x of docs) { try { await syncWait(x.id, null, x.data()); } catch (e) { logger.error("waiting list failed", e); } }
});
out["onAbsenceUpdated" + suffix] = onDocumentUpdated(on("absences/{id}"), async event => {
  const a = event.data?.after?.data(); if (!a) return;
  for (const x of await absenceTrainings(a)) { try { await syncWait(x.id, null, x.data()); } catch (e) { logger.error("waiting list failed", e); } }
});

// Every 15 minutes: remind once when the answer deadline ends within the next 3 hours
out["deadlineReminder" + suffix] = onSchedule({ schedule: "every 15 minutes", timeZone: TZ }, async () => {
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
      link: "#termin-" + d.id, tag: "remind-" + d.id,
    });
  }
});

// Fridays at noon: every player with an open amount gets a reminder with the amount
out["paymentReminder" + suffix] = onSchedule({ schedule: "0 12 * * 5", timeZone: TZ }, async () => {
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
out["birthdays" + suffix] = onSchedule({ schedule: "0 8 * * *", timeZone: TZ }, async () => {
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

return out;
}

Object.assign(exports, forDatabase("(default)", ""), forDatabase("test", "Test"));

// Developer only: fills the test database with a copy of the live data. Push tokens, the
// Team-Info and the push log are not copied, so the test database never messages the team.
const COPY = ["members", "players", "roster", "trainings", "drafts", "kasse", "billing", "fines", "ledger", "absences", "profiles"];
const WIPE = [...COPY, "news", "tokens", "pushlog"];
exports.copyToTest = onCall({ timeoutSeconds: 300 }, async req => {
  const email = String(req.auth?.token?.email || "").toLowerCase();
  if (!email || req.auth.token.email_verified !== true) throw new HttpsError("unauthenticated", "Bitte anmelden.");
  const live = getFirestore(), test = getFirestore("test");
  const me = await live.collection("members").doc(email).get();
  if (!me.exists || me.data().role !== "developer") throw new HttpsError("permission-denied", "Nur für Entwickler.");
  for (const c of WIPE) await test.recursiveDelete(test.collection(c));
  const counts = {};
  const w = test.bulkWriter();
  for (const c of COPY) {
    const snap = await live.collection(c).get();
    counts[c] = snap.size;
    // bulk: copied appointments do not announce themselves as "Neuer Termin"
    snap.forEach(d => w.set(test.collection(c).doc(d.id), c === "trainings" ? { ...d.data(), bulk: true } : d.data()));
  }
  await w.close();
  counts.demo = await addTestCases(test, email, me.data());
  logger.info(`test database filled by ${email}`, counts);
  return counts;
});

// Test cases on top of the copied data, so every feature can be tried at once:
// an own player entry for the developer, a training tomorrow and a game in 5 days, a training
// within 24 hours with a late sick report (to confirm) and missing jerseys, a poll and a greeting.
async function addTestCases(test, email, member) {
  const H = 3600e3, D = 24 * H, now = Date.now();
  const at = (days, hour) => { const x = new Date(now + days * D); x.setUTCHours(hour - 1, 0, 0, 0); return Timestamp.fromMillis(x.getTime()); };  // Rome = UTC+1 in winter
  const added = [];
  // the developer gets an own player entry (if not linked yet) to try everything as a player
  let myPid = member.playerId || "";
  if (!myPid) {
    myPid = "test-ich";
    const name = (member.name || "Ich") + " (Test)";
    await test.collection("players").doc(myPid).set({ name, pos: "O", rating: 5, active: true, email });
    await test.collection("roster").doc(myPid).set({ name, pos: "O", active: true, access: true });
    await test.collection("members").doc(email).set({ playerId: myPid }, { merge: true });
    added.push("eigener Spieler");
  }
  const roster = (await test.collection("roster").get()).docs.map(d => ({ id: d.id, ...d.data() }))
    .filter(r => r.active && r.access && r.id !== myPid);
  const T = (start, extra) => ({ start, place: "Eishalle (Test)", kind: "training", note: "Testtermin", cancelled: false, responses: {}, duration: 60, createdAt: now, bulk: true, ...extra });
  const soon = test.collection("trainings").doc("test-heute");
  await soon.set(T(Timestamp.fromMillis(now + 20 * H), {}));
  await test.collection("trainings").doc("test-morgen").set(T(at(1, 20), {}));
  await test.collection("trainings").doc("test-spiel").set(T(at(5, 21), { kind: "game", place: "Auswärts (Test)", duration: 90 }));
  added.push("3 Termine");
  if (roster.length >= 2) {
    const [sick, keeper] = roster;
    // jerseys: the responsible player cancelled the training within 24 hours
    await test.collection("players").doc(keeper.id).set({ material: true }, { merge: true });
    await test.collection("roster").doc(keeper.id).set({ material: true }, { merge: true });
    await soon.update({ [`responses.${keeper.id}`]: "out" });
    // late sick report for the training within 24 hours: waits for a trainer
    await test.collection("absences").add({ pid: sick.id, from: now - H, to: now + 2 * D, reason: "krank", note: "Testfall", by: email, byName: "Test", byTrainer: false, at: Timestamp.now() });
    added.push(`Spätabmeldung ${sick.name}`, `Trikots ${keeper.name}`);
  }
  await test.collection("news").add({ title: "Weihnachtsfeier (Test)", text: "Welcher Samstag passt euch?", options: ["Samstag, 12.12.", "Samstag, 19.12."], votes: {}, at: Timestamp.now(), by: "Test", kind: "poll" });
  await test.collection("news").add({ title: "Willkommen in der Testdatenbank", text: "Hier kannst du alles ausprobieren – die Mannschaft sieht nichts davon.", at: Timestamp.now(), by: "Test", kind: "info" });
  added.push("Umfrage", "Team-Info");
  return added;
}
