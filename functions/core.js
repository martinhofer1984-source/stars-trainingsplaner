// Attendance, waiting list and open amounts, computed on the server exactly like in the app
// (index.html: answerOf, attendees, chargesOf). Kept free of Firebase so it can be tested alone.
//
// Data shape (plain values, all times in milliseconds):
//   d.roster:    {pid: {pos: "G"|"D"|"O", access, active, material}}
//   d.absences:  [{pid, from, to, at, byTrainer, confirmed: {tid: true}}]
//   trainings:   {id, start, kind, duration, cancelled, responses, wait, noshow}
//   d.trainings: all appointments, d.kasse: kasse/settings, d.billing: {pid: {plan, paid}}, d.fines: [{pid, amount}]
const DEADLINE_MS = 24 * 3600e3;
const OVER_FALLBACK_MS = 2 * 3600e3;

// Most players per appointment: games 3 full lines (3 x 2 defenders + 3 forwards) and 2 goalies,
// trainings 20 field players and 2 goalies. Defenders and forwards count together.
const CAP = { game: { field: 15, goal: 2 }, training: { field: 20, goal: 2 } };
const capOf = t => t.kind === "game" ? CAP.game : CAP.training;
const slotOf = r => r && r.pos === "G" ? "goal" : "field";

const waitOf = t => Array.isArray(t.wait) ? t.wait : [];
const deadlineOf = t => t.start - DEADLINE_MS;
const absenceFor = (d, t, pid) => d.absences.find(a => a.pid === pid && t.start >= a.from && t.start <= a.to) || null;
function absenceState(d, t, pid) {
  const a = absenceFor(d, t, pid); if (!a) return null;
  return a.byTrainer || a.at < deadlineOf(t) || (a.confirmed && a.confirmed[t.id]) ? "out" : "pending";
}
// "in", "out" or "wait" (on the waiting list)
function answerOf(d, t, pid) {
  if (absenceState(d, t, pid) === "out") return "out";
  const r = (t.responses || {})[pid];
  if (r === "out") return "out";
  if (waitOf(t).includes(pid)) return "wait";
  if (r === "in") return "in";
  const ro = d.roster[pid]; return ro && ro.access && ro.active ? "in" : "out";
}
const listed = (d, t) => Object.keys(d.roster).filter(pid => d.roster[pid].active || (t.responses || {})[pid] === "in");
const attendeeIds = (d, t) => listed(d, t).filter(pid => answerOf(d, t, pid) === "in");
function slotCounts(d, t) {
  const c = { field: 0, goal: 0 };
  for (const pid of attendeeIds(d, t)) c[slotOf(d.roster[pid])]++;
  return c;
}

// Waiting list after a change: players who answered "in" while the appointment was full join the
// end of the list; whoever cancelled leaves it; free places go to the first waiting player of the
// matching kind (goalie or field player). Returns the new list and the players who moved up.
function waitUpdate(d, before, t) {
  const cap = capOf(t), c = slotCounts(d, t);
  let wait = waitOf(t).filter(pid => answerOf(d, t, pid) === "wait");
  // Without the previous state (absence changes) nobody joins the list, places are only filled
  const was = before ? (before.responses || {}) : null;
  if (was) for (const pid of Object.keys(t.responses || {})) {
    if (t.responses[pid] !== "in" || was[pid] === "in" || wait.includes(pid) || answerOf(d, t, pid) !== "in") continue;
    const s = slotOf(d.roster[pid]);
    if (c[s] > cap[s]) { wait.push(pid); c[s]--; }
  }
  const promoted = [];
  for (const pid of wait) {
    const s = slotOf(d.roster[pid]);
    if (c[s] < cap[s]) { c[s]++; promoted.push(pid); }
  }
  wait = wait.filter(pid => !promoted.includes(pid));
  return { wait, promoted };
}

// ---------- cash box ----------
const seasonOf = ms => { const x = new Date(ms); return x.getMonth() >= 8 ? x.getFullYear() : x.getFullYear() - 1; };
const TARIFF_DEFAULT = { annual: 200, training: 15, student: 10, noshow: 0 };
const PLANS = ["training", "student", "annual", "free"];
function tariffOf(d, season) {
  const all = (d.kasse && d.kasse.seasons) || {};
  if (all[season]) return { ...TARIFF_DEFAULT, ...all[season] };
  const older = Object.keys(all).map(Number).filter(y => y < season).sort((a, b) => b - a)[0];
  return { ...TARIFF_DEFAULT, ...(older !== undefined ? all[older] : {}) };
}
const planOf = (d, pid) => PLANS.includes(d.billing[pid] && d.billing[pid].plan) ? d.billing[pid].plan : "training";
const isOver = (t, now) => (Number.isFinite(t.duration) && t.duration > 0 ? t.start + t.duration * 60000 : t.start + OVER_FALLBACK_MS) <= now;
const isGame = t => t.kind === "game";

function chargesOf(d, pid, now = Date.now()) {
  const startAt = d.kasse && Number.isFinite(d.kasse.startAt) ? d.kasse.startAt : -Infinity;
  const firstSeason = Math.min(seasonOf(now), ...d.trainings.map(t => seasonOf(t.start)), ...(Number.isFinite(startAt) ? [seasonOf(startAt)] : []));
  const plan = planOf(d, pid), out = [];
  if (plan === "annual")
    for (let y = Number.isFinite(startAt) ? seasonOf(startAt) : firstSeason; y <= seasonOf(now); y++)
      out.push({ key: "y:" + y, amount: tariffOf(d, y).annual });
  const gameCost = t => +((d.kasse && d.kasse.gameCost && d.kasse.gameCost[t.id]) || 0) || 0;
  for (const t of d.trainings) {
    if (!isOver(t, now) || t.cancelled || t.start < startAt) continue;
    const tf = tariffOf(d, seasonOf(t.start)), a = answerOf(d, t, pid);
    const there = a === "in" && !(Array.isArray(t.noshow) && t.noshow.includes(pid));
    if (there) {
      if (!isGame(t) && (plan === "training" || plan === "student")) out.push({ key: "t:" + t.id, amount: plan === "student" ? tf.student : tf.training });
      if (isGame(t) && gameCost(t) > 0) out.push({ key: "g:" + t.id, amount: gameCost(t) });
    } else if (a === "in" && tf.noshow > 0) out.push({ key: "n:" + t.id, amount: tf.noshow });
  }
  for (const f of d.fines) if (f.pid === pid && +f.amount > 0) out.push({ key: "f:" + f.id, amount: +f.amount });
  return out.filter(c => c.amount > 0);
}
function openOf(d, pid, now = Date.now()) {
  const paid = (d.billing[pid] && d.billing[pid].paid) || {};
  return chargesOf(d, pid, now).filter(c => !paid[c.key]).reduce((s, c) => s + c.amount, 0);
}

module.exports = { CAP, capOf, slotOf, waitOf, absenceState, answerOf, attendeeIds, slotCounts, waitUpdate, chargesOf, openOf, DEADLINE_MS };
