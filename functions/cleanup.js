// Removes old entries from the Team-Info feed ("news"):
//  - automatic entries about an appointment once it is over (or deleted)
//  - entries with an end time ("until", e.g. birthdays) at that time
//  - everything else (trainer messages, polls, entries without appointment) after 7 days
const INFO_DAYS = 7;
const OVER_FALLBACK_MS = 2 * 3600e3;   // appointments without a duration count as 2 hours

const ms = v => (v && typeof v.toMillis === "function") ? v.toMillis() : (Number.isFinite(v) ? v : 0);
// Appointment an automatic entry belongs to: stored as tid, older entries only have it in the tag
const tidOf = n => n.tid || ((/^(?:t|teams|lines)-(.+)$/.exec(n.tag || "") || [])[1]) || null;
const endOf = t => ms(t.start) + (Number.isFinite(t.duration) && t.duration > 0 ? t.duration * 60000 : OVER_FALLBACK_MS);

async function cleanupNews(db, now = Date.now()) {
  const snap = await db.collection("news").get();
  const tids = [...new Set(snap.docs.map(d => d.data().kind === "event" ? tidOf(d.data()) : null).filter(Boolean))];
  const trainings = new Map();
  if (tids.length) {
    const docs = await db.getAll(...tids.map(id => db.collection("trainings").doc(id)));
    docs.forEach(d => trainings.set(d.id, d.exists ? d.data() : null));
  }
  const old = now - INFO_DAYS * 24 * 3600e3, gone = [];
  for (const d of snap.docs) {
    const n = d.data(), tid = n.kind === "event" ? tidOf(n) : null;
    if (n.until) { if (ms(n.until) <= now) gone.push(d.ref); }
    else if (tid) { const t = trainings.get(tid); if (!t || endOf(t) <= now) gone.push(d.ref); }
    else if (ms(n.at) < old) gone.push(d.ref);
  }
  for (let i = 0; i < gone.length; i += 400) {
    const b = db.batch(); gone.slice(i, i + 400).forEach(r => b.delete(r)); await b.commit();
  }
  return gone.length;
}

module.exports = { cleanupNews, tidOf, INFO_DAYS };
