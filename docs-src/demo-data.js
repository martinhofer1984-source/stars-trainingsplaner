// Demo mode for screenshots: example data instead of the database, view chosen by ?shot=...&mark=css-selector
(function demo(){
  const q = new URLSearchParams(location.search), shot = q.get("shot") || "termine";
  const at = (d, h, m) => { const x = new Date(); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() + d); x.setHours(h, m || 0); return x.getTime(); };
  S.authKnown = true;
  if (shot === "login") { S.user = null; history.replaceState(null, "", location.pathname + location.search); render(); return mark(); }
  S.user = {email: "tom@beispiel.it"}; S.role = "player";
  document.body.classList.add("is-player", "no-kasse");
  S.me = {email: "tom@beispiel.it", playerId: "tom", name: "Tom"};
  const R = (id, name, pos, number, access = true) => ({id, name, pos, active: true, access, ...(number ? {number} : {})});
  S.roster = Object.fromEntries([
    R("tom", "Tom", "O", 17), R("max", "Max", "D", 4), R("lukas", "Lukas", "O", 9), R("paul", "Paul", "G", 1),
    R("jonas", "Jonas", "D", 22), R("felix", "Felix", "O", 11), R("ben", "Ben", "D", 6), R("leon", "Leon", "O", 19),
    R("elias", "Elias", "G", 30), R("noah", "Noah", "O", 8), R("finn", "Finn", "D", 3), R("david", "David", "O", 14),
  ].map(r => [r.id, r]));
  const T = (id, d, h, m, extra = {}) => ({id, start: at(d, h, m), duration: 60, kind: "training", place: "Eishalle", responses: {}, note: "", cancelled: false, ...extra});
  S.allTrainings = [
    T("p1", -9, 20, 0, {}), T("p2", -6, 20, 0, {}), T("p3", -3, 21, 30, {kind: "game", duration: 90, place: "Burgstall"}),
    T("t1", 2, 20, 0, {responses: {david: "out", finn: "out"},
      teams: {A: ["tom", "max", "paul", "felix", "ben"], B: ["lukas", "jonas", "elias", "leon", "noah"], at: Date.now()}}),
    T("g1", 6, 21, 30, {kind: "game", duration: 90, place: "Burgstall", responses: {noah: "out"},
      lines: {d: 2, o: 2, slot: {paul: "G", max: "V1", jonas: "V1", ben: "V2", finn: "V2", tom: "S1", lukas: "S1", felix: "S1", leon: "S2", david: "S2", elias: "G"}, at: Date.now()}}),
    T("t2", 9, 20, 0), T("t3", 13, 20, 30),
  ];
  S.kasse = {seasons: {[seasonOf(Date.now())]: {annual: 200, training: 15, student: 10, noshow: 5}}, gameCost: {p3: 8}};
  S.billing = {tom: {plan: "training", paid: {"t:p1": Date.now()}}};
  S.fines = [{id: "f1", pid: "tom", reason: "Trikot vergessen", amount: 5, at: at(-3, 22, 0)}];
  S.news = [
    {id: "n1", title: "Neue Trikots", text: "Die neuen Trikots liegen ab Freitag in der Kabine. Bitte die Größe auf der Liste abhaken.", at: at(0, 9, 15), by: "Trainer", kind: "info"},
    {id: "n2", title: "Teams sind eingeteilt", text: "Training " + dDay(at(2, 20)) + " um 20:00 Uhr – Eishalle: Schau nach, in welchem Team du spielst.", at: at(0, 8, 0), by: "App", kind: "event", tid: "t1"},
  ];
  S.loaded = {players: true, roster: true, trainings: true};
  S.sel = q.get("sel") || "t1";
  if (shot === "abgesagt") S.allTrainings.find(t => t.id === S.sel).responses.tom = "out";
  splitTrainings(); S.sel = q.get("sel") || "t1";
  const view = {termine: "training", detail: "training", abgesagt: "training", teams: "training", linien: "training", kalender: "training", menu: "training", info: "info", push: "konto", beitraege: "konto"}[shot] || "training";
  if (view !== "info") try { localStorage.setItem("stars-news-seen", "0"); } catch {}
  history.replaceState(null, "", location.pathname + location.search + "#" + view);
  render();
  if (shot === "menu") { $(".menu").classList.add("open"); }
  const target = {detail: "#detailPanel", abgesagt: "#detailPanel", teams: "#genPanel", linien: "#linePanel", kalender: ".row.cal", push: "#pushBox", beitraege: "#myFeesPanel"}[shot];
  if (target) { const el = document.querySelector(target); if (el) window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 86); }
  mark();
  function mark(){
    const sel = q.get("mark"); if (!sel) return;
    for (const el of document.querySelectorAll(sel)) { el.style.outline = "4px solid #e53935"; el.style.outlineOffset = "3px"; el.style.borderRadius = "10px"; }
  }
})();
