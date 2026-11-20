# Quellen der Anleitungen

- `anleitung.html` (Spieler), `trainer.html`, `kassier.html` mit `style.css` und Bildern in `img/`
- PDF erzeugen (Windows, Edge):
  `msedge --headless=new --no-pdf-header-footer --print-to-pdf=<ziel.pdf> file:///<pfad>/trainer.html`
- Die fertigen PDFs liegen in `../docs/` (werden von der App im Tab Downloads angeboten).
- `demo-data.js` / `demo-staff.js`: Beispieldaten fuer die Bildschirmfotos. Sie ersetzen in einer Kopie von
  `index.html` den Aufruf `initStore();` (Demo-Modus ohne Datenbank, Ansicht ueber `?shot=...`).
