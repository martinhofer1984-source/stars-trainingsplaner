// Demo mode for trainer/cashier screenshots: ?role=trainer|cashier&shot=...&sel=...&mark=css
(function demo(){
  const q = new URLSearchParams(location.search), shot = q.get("shot") || "termine", role = q.get("role") || "trainer";
  const at = (d, h, m) => { const x = new Date(); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() + d); x.setHours(h, m || 0); return x.getTime(); };
  S.authKnown = true;
  S.user = {email: "coach@beispiel.it"}; S.role = role;
  document.body.classList.toggle("is-player", role !== "trainer");
  document.body.classList.toggle("no-kasse", false);
  S.me = {email: "coach@beispiel.it", playerId: role === "cashier" ? "max" : "tom", name: "Coach"};
  const P = [["tom","Tom","O",17,6.5],["max","Max","D",4,7.2],["lukas","Lukas","O",9,5.8],["paul","Paul","G",1,7.5],["jonas","Jonas","D",22,6.1],
    ["felix","Felix","O",11,8.0],["ben","Ben","D",6,5.4],["leon","Leon","O",19,6.9],["elias","Elias","G",30,6.0],["noah","Noah","O",8,4.9],
    ["finn","Finn","D",3,6.6],["david","David","O",14,5.2],["gast","Gustav","O",0,5.0]];
  S.roster = {}; S.players = {}; S.members = {};
  for (const [id, name, pos, number, rating] of P) {
    const access = id !== "gast";
    S.roster[id] = {id, name, pos, active: true, access, ...(number ? {number} : {})};
    S.players[id] = {id, name, pos, rating, active: true, ...(number ? {number} : {}), ...(access ? {email: id + "@beispiel.it"} : {})};
    if (access) S.members[id + "@beispiel.it"] = {name, role: id === "max" ? "cashier" : "player", playerId: id};
  }
  const T = (id, d, h, m, extra = {}) => ({id, start: at(d, h, m), duration: 60, kind: "training", place: "Eishalle", responses: {}, note: "", cancelled: false, ...extra});
  const teamsT1 = {A: ["tom", "max", "paul", "felix", "ben", "finn"], B: ["lukas", "jonas", "elias", "leon", "noah", "gast"]};
  const linesG1 = {d: 2, o: 2, slot: {paul: "G", elias: "G", max: "V1", jonas: "V1", ben: "V2", finn: "V2", tom: "S1", lukas: "S1", felix: "S1", leon: "S2", david: "S2"}};
  S.allTrainings = [
    T("p1", -9, 20, 0, {teams: {A: ["tom","max","paul","felix","ben"], B: ["lukas","jonas","elias","leon","noah"], at: 1}, result: {a: 4, b: 3}}),
    T("p2", -6, 20, 0, {responses: {david: "out"}, noshow: ["noah"]}),
    T("p3", -3, 21, 30, {kind: "game", duration: 90, place: "Burgstall", responses: {finn: "out"}}),
    T("t1", 2, 20, 0, {responses: {david: "out", gast: "in"}}),
    T("g1", 6, 21, 30, {kind: "game", duration: 90, place: "Burgstall", responses: {noah: "out"}, lines: {...linesG1, at: Date.now()}}),
    T("t2", 9, 20, 0), T("t3", 13, 20, 30),
  ];
  S.drafts = {t1: {...teamsT1, at: Date.now()}, g1: {lines: linesG1, at: Date.now()}};
  S.kasse = {seasons: {[seasonOf(Date.now())]: {annual: 200, training: 15, student: 10, noshow: 5}}, gameCost: {p3: 8}};
  S.billing = {max: {plan: "annual", paid: {["y:" + seasonOf(Date.now())]: Date.now()}}, lukas: {plan: "student"}, paul: {plan: "free"}, tom: {plan: "training", paid: {"t:p1": Date.now()}}};
  S.fines = [{id: "f1", pid: "tom", reason: "Trikot vergessen", amount: 5, at: at(-3, 22, 0), by: "Coach"}];
  S.ledger = [
    {id: "l1", type: "correction", date: at(-20, 12), text: "Anfangsbestand Kasse", amount: 350, by: "max@beispiel.it", byName: "Max", at: at(-20, 12), confirmedBy: "coach@beispiel.it", confirmedByName: "Coach", confirmedAt: at(-19, 9)},
    {id: "l2", type: "expense", date: at(-3, 12), text: "Eisstunde Burgstall", amount: 120, by: "coach@beispiel.it", byName: "Coach", at: at(-3, 22), confirmedBy: "max@beispiel.it", confirmedByName: "Max", confirmedAt: at(-2, 10)},
    {id: "l3", type: "expense", date: at(-1, 12), text: "Schiri Spiel Burgstall", amount: 40, by: "coach@beispiel.it", byName: "Coach", at: at(-1, 20)},
  ];
  S.news = [{id: "n1", title: "Neue Trikots", text: "Die neuen Trikots liegen ab Freitag in der Kabine.", at: at(0, 9, 15), by: "Coach", kind: "info"}];
  S.loaded = {players: true, roster: true, trainings: true};
  splitTrainings(); S.sel = q.get("sel") || "t1";
  if (q.get("open")) S.openPast = q.get("open");
  if (q.get("kopen")) S.openKasse = q.get("kopen");
  if (q.get("res")) { const [a, b] = q.get("res").split(":"); S.resDraft = {id: S.openPast, a, b}; }
  try { localStorage.setItem("stars-news-seen", String(Date.now())); } catch {}
  const views = {neu: "training", anwesend: "training", teams: "training", linien: "training", tcancel: "training", spieler: "spieler", ergebnisse: "ergebnisse",
    statistik: "statistik", kasse: "kasse", strafe: "kasse", spielkosten: "kasse", tarife: "kasse", info: "info", konto: "konto", menu: "training"};
  history.replaceState(null, "", location.pathname + location.search + "#" + (views[shot] || "training"));
  if (shot === "ergebnisse") $("#resFilter").value = "open";
  if (shot === "kasse") $("#kasseFilter").value = "all";
  render();
  if (shot === "neu") $("#newTraining").open = true;
  if (shot === "strafe") $("#newFine").open = true;
  if (shot === "info") $("#newNews").open = true;
  if (shot === "menu") $(".menu").classList.add("open");
  if (shot === "neu") { $("#ntStart").value = new Date(at(9, 20) - new Date().getTimezoneOffset() * 6e4).toISOString().slice(0, 16); $("#ntPlace").value = "Eishalle"; }
  if (shot === "strafe") { $("#fnPlayer").value = "tom"; $("#fnReason").value = "Trikot vergessen"; $("#fnAmount").value = "5"; }
  if (shot === "info") { $("#nnTitle").value = "Training fällt aus"; $("#nnText").value = "Die Halle ist am Samstag gesperrt."; }
  const target = {neu: "#newTraining", anwesend: "#attPanel", teams: "#genPanel", linien: "#linePanel", tcancel: "[data-tcancel]", strafe: "#newFine",
    spielkosten: "#gameCosts", tarife: "#tariffBox", konto: "#myFeesPanel"}[shot];
  const off = +(q.get("off") || 86);
  // Bring the target to the top by hiding what is above it (scrolling does not survive the screenshot)
  if (target) {
    const el = document.querySelector(target);
    const sec = el && el.closest("section");
    if (sec) {
      let s = sec.previousElementSibling;
      while (s) { if (s.tagName === "SECTION") s.style.display = "none"; s = s.previousElementSibling; }
      const hideIn = (q.get("hidein") || "").split(",").filter(Boolean);
      hideIn.forEach(x => sec.querySelectorAll(x).forEach(n => n.style.display = "none"));
    }
    window.scrollTo(0, 0);
  }
  const sel = q.get("mark");
  if (sel) for (const el of document.querySelectorAll(sel)) { el.style.outline = "4px solid #e53935"; el.style.outlineOffset = "3px"; el.style.borderRadius = "10px"; }
})();
