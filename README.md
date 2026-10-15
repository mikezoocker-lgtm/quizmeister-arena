# Quizmeister Arena

Online-Quizshow im Jeopardy-Format für Spieler an verschiedenen Orten. Der Quizmaster steuert alles über `/host`. Die Spieler sehen Board, Fragen, Timer, Punktestände und ihren Buzzer unter `/play`. Die Sprachkommunikation läuft extern (Discord, Zoom, Jitsi …).

- **Node.js + Express + Socket.IO**, Frontend in reinem HTML/CSS/JS, kein Build-Schritt
- Server ist die einzige Wahrheit (Punkte, Timer, Buzzer, Zugrecht)
- Timer über Endzeitstempel und Uhrsynchronisation per Ping/Pong
- Fairer Buzzer mit Latenzausgleich, Sammelfenster und Plausibilitätsprüfung
- Reconnect ohne Platzverlust, Online-Status, Auto-Pause, wenn der Host offline geht
- Keine Datenbank, keine externen Dienste

## Seiten

| Pfad | Zweck |
|---|---|
| `/` | Startseite |
| `/host` | Steuerpult für den Quizmaster (Passwort = `HOST_PASSWORD`) |
| `/play?room=ABCD` | Spieleransicht mit Buzzer (Einladungslink) |
| `/watch?room=ABCD` | Reine Zuschaueransicht |
| `/healthz` | Health-Check für Render |

## Lokal starten

```bash
npm install
HOST_PASSWORD=geheim npm start
# http://localhost:3000/host
```

Unter Windows (PowerShell): `$env:HOST_PASSWORD="geheim"; npm start`

Ohne gesetztes `HOST_PASSWORD` gilt das Standardpasswort `quizmeister`. Bitte nur lokal so verwenden.

## Auf GitHub hochladen

1. Auf github.com ein neues, leeres Repository anlegen, z. B. `quizmeister-arena`.
2. Im Projektordner:
   ```bash
   git init
   git add .
   git commit -m "Quizmeister Arena"
   git branch -M main
   git remote add origin https://github.com/DEIN-NAME/quizmeister-arena.git
   git push -u origin main
   ```

## Auf Render deployen (Free Tier)

**Variante A – Blueprint:** Auf render.com **New → Blueprint** wählen und das Repo verbinden. Die `render.yaml` wird erkannt. Render fragt nach `HOST_PASSWORD`; dort dein Passwort eintragen.

**Variante B – manuell:** **New → Web Service** wählen und das Repo verbinden.
- Runtime: Node
- Build Command: `npm install`
- Start Command: `npm start`
- Instance Type: Free
- Unter *Environment* die Variable `HOST_PASSWORD` mit deinem Passwort anlegen

Nach dem Deploy erreichst du die App unter `https://<dein-service>.onrender.com`. Öffne `/host`, melde dich an, klicke **Runde anlegen** und schick den Einladungslink an deine Mitspieler.

**Hinweise zum Free Tier**
- Der Dienst schläft nach ca. 15 Minuten ohne Traffic ein. Der erste Aufruf dauert dann 30–60 Sekunden. Öffne `/host` also ein paar Minuten vor Spielbeginn.
- Der Spielzustand liegt im Arbeitsspeicher. Bei einem Neustart oder neuem Deploy sind laufende Runden weg. Während des Spiels also nicht deployen.
- Während des Spiels halten WebSocket-Verbindungen und Heartbeats den Dienst wach.

## Fragen pflegen

Die Fragen stehen in `questions.json`:

```json
{
  "categories": [
    {
      "name": "Kategoriename",
      "questions": [
        { "value": 100, "question": "Frage?", "answer": "Antwort", "image": "https://…/bild.jpg", "answerImage": "" }
      ]
    }
  ]
}
```

`image` (Bild zur Frage) und `answerImage` (Bild, das erst bei der Auflösung erscheint) sind optional. Erlaubt sind URLs, Pfade wie `/img/foto.jpg` (Datei in `public/img/` ablegen) oder im Editor hochgeladene Bilder. Für eine „Wer ist das?“-Kategorie im Editor auf **+ Bildkategorie** klicken und pro Feld ein Foto hochladen. Exportierte Dateien enthalten hochgeladene Bilder direkt eingebettet. Die Felder wählt immer der Quizmaster: Der Spieler am Zug sagt Kategorie und Wert an. Pro Kategorie werden die ersten N Fragen genutzt, je nach Einstellung „Stufen“ (3–6). Es erscheinen die ersten M Kategorien, je nach Einstellung „Kategorien“ (3–6).

**Fragen dauerhaft speichern:** Das Dateisystem auf Render ist nicht dauerhaft. Bearbeitete Fragen gehen daher bei einem Neustart verloren.
1. Im Host-Pult unter **Fragen-Editor → JSON exportieren** die Datei `questions.json` herunterladen.
2. Die Datei im Projektordner ersetzen und committen:
   ```bash
   git add questions.json
   git commit -m "Neue Fragen"
   git push
   ```
3. Render deployt automatisch neu. Jede neue Runde startet dann mit diesen Fragen.

Alternativ kannst du vor jedem Spiel eine JSON-Datei per **JSON importieren** laden und **Fragen übernehmen** klicken.

## Spielablauf

1. Spieler treten per Link bei und erscheinen in der Lobby. Du wählst den Startspieler oder lässt ihn auslosen.
2. Der Spieler am Zug wählt ein Feld. Je nach Einstellung klickst stattdessen du auf das angesagte Feld.
3. Für ihn läuft der Antwort-Timer (gold). Du bewertest mit **Richtig** (Taste R) oder **Falsch** (Taste F).
   - Bei richtiger Antwort gibt es die vollen Punkte, und er wählt erneut.
   - Bei falscher Antwort oder abgelaufener Zeit werden ihm die halben Punkte abgezogen (abgerundet). Danach öffnet sich der Buzzer für alle anderen.
4. Wer den Buzzer gewinnt, bekommt das Wort, und ein kürzerer Timer läuft (orange gestreift). Bei richtiger Antwort gibt es volle Punkte, bei falscher den halben Abzug (abschaltbar). Der Spieler wird gesperrt, und der Buzzer öffnet sich erneut.
5. Wenn niemand mehr buzzern kann oder du **Frage beenden** klickst, wird die Antwort aufgedeckt. Das Feld ist dann erledigt, und der nächste Spieler in der Reihenfolge ist am Zug.
6. Wenn alle Felder erledigt sind, folgt die Siegerehrung mit Podium und Konfetti. **Neues Spiel** behält die Spieler und setzt Punkte und Felder zurück.

Weitere Host-Funktionen:
- Timer pausieren und +10 s
- Antwort vorzeitig aufdecken
- Frage ohne Wertung zurück aufs Board legen
- Undo der letzten Punktevergabe
- Spieler anlegen, umbenennen, umfärben, entfernen, Zug geben und Punkte manuell korrigieren

## Fairer Buzzer – so funktioniert er

- Der Server misst alle 2 Sekunden die Latenz (RTT) jedes Spielers und verwendet davon den Median.
- Bei der Freigabe merkt sich der Client den Empfangszeitpunkt. Beim Buzzen schickt er die vergangene Zeit seit dem Empfang mit. Das ist die reine Reaktionszeit, ohne Netzwerk.
- Der Server sammelt alle Buzzes in einem Fenster ab dem ersten Buzz (Standard 400 ms, einstellbar). Es gewinnt die niedrigste Reaktionszeit.
- Plausibilitätsprüfung:
  - Werte unter 80 ms werden verworfen.
  - Werte, die zur Servermessung und zur Latenz nicht passen, werden markiert und durch die Serverschätzung ersetzt (Serverzeit minus RTT).
  - Alles steht im Buzz-Protokoll des Host-Pults.
- Frühbuzzer (vor der Freigabe) werden 1 Sekunde gesperrt.
- Mit dem Schalter **Buzzer-Modus → Einfach** gewinnt, wer zuerst beim Server ankommt.

## Projektstruktur

```
server.js            Spiellogik, Socket.IO, Timer, Buzzer
questions.json       Fragenkatalog
public/
  index.html         Startseite
  host.html          Quizmaster-Pult
  play.html          Spieleransicht
  watch.html         Zuschaueransicht
  css/style.css
  js/common.js       Verbindung, Uhrsync, Sounds, Board, Timer, Podium
  js/host.js
  js/play.js         (auch für /watch)
render.yaml
package.json
```
