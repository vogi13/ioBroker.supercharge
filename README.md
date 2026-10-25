![Logo](admin/supercharge.png)

# ioBroker.supercharge

Akkuschonendes Laden von **1 bis 4 E-Bikes** über schaltbare Steckdosen mit Leistungsmessung
(z. B. Shelly Plug S, Plus Plug S, 1PM, 2PM).

*English summary: charges up to four e-bikes to a target state of charge (60 / 80 / 100 %). The state of charge is estimated
from the charging power and the recorded CC/CV charge curve of each bike; the plug is switched off at the target.*

## Was der Adapter kann

- **Ladestand schätzen ohne Verbindung zum Akku:** Aus der Ladeleistung und ihrer Tendenz (steigende CC- bzw. fallende CV-Flanke)
  wird der Ladestand mit der einmal aufgezeichneten Ladekurve des Rads bestimmt.
- **Ladeziel:** Lagerung (60 %), Alltag (80 %) oder Tour (100 %) – die ersten beiden Werte sind einstellbar.
- **100 % mit Fertig-Uhrzeit:** lädt sofort bis 80 %, pausiert und lädt so rechtzeitig weiter, dass der Akku etwa 20 min vor der
  gewünschten Uhrzeit voll ist.
- **Backup-Zeitfenster:** Wird ioBroker regelmäßig für ein Backup heruntergefahren, werden Uhrzeit, Dauer und Wochentage
  beim Planen ausgespart.
- **Fortsetzen nach Neustart:** Laufende Ladungen und Pausen laufen nach einem Neustart von ioBroker weiter.
- **Sicherheit:** Abbruch, wenn kein Akku angesteckt ist; Sicherheitsabschaltung nach einstellbarer Ladezeit.
- **Web-App** für Handy, Tablet und PC mit einfacher und erweiterter Ansicht.

## Voraussetzungen

- ioBroker mit js-controller ≥ 5 und Admin ≥ 6.17
- je Rad eine schaltbare Steckdose mit Leistungsmessung, die in ioBroker einen Schalt- und einen Leistungs-Datenpunkt hat
- für die App ist **kein weiterer Adapter nötig** – Supercharge bringt einen eigenen kleinen Webserver mit
  (wahlweise geht es weiterhin über **web** + **simple-api**)

## Installation

Der Adapter ist nicht im offiziellen ioBroker-Repository. Installation über GitHub:

1. Admin → **Adapter** → Expertenmodus einschalten → GitHub-Symbol („Installieren aus eigener URL“).
2. Reiter „Beliebig“ bzw. „Benutzerdefiniert“: `https://github.com/vogi13/ioBroker.supercharge` eintragen und installieren.
3. In der Adapter-Liste bei **supercharge** auf „+“ klicken, um eine Instanz anzulegen.

Ohne GitHub geht es auch mit der Paketdatei auf der Kommandozeile des ioBroker-Rechners (bzw. im Container):

```
iobroker url /pfad/zu/iobroker.supercharge-0.1.0.tgz
iobroker add supercharge
```

**Update:** dieselbe URL erneut installieren (bzw. die neue .tgz-Datei).

## Einrichtung

**Instanzen → supercharge → Einstellungen**

| Reiter | Inhalt |
|---|---|
| Räder | 1–4 Zeilen mit Nummer, Name, Farbe, Schalter- und Leistungs-Datenpunkt. Die Nummer bestimmt den Ordner (`rad1` … `rad4`); ein Umbenennen ändert Ladekurve und Statistik nicht. |
| Laden | Abschalt-Schwelle, Sicherheitsabschaltung, Fortsetzen nach Neustart, Pause bei … %, Puffer, kürzeste Pause, Ladeziele |
| Backup | Backup aussparen ein/aus, Beginn, Dauer, Puffer davor/danach, Wochentage |
| App | eigener Webserver ein/aus, IP, Port (Standard 8095), optionales Passwort; Datenquelle der App: eigener Webserver oder simple-api (Instanz, optional Adresse) |

Nur wenn die App über **simple-api** läuft: nach dem ersten Start einmal die simple-api-Instanz neu starten, damit sie die neuen
Datenpunkte kennt.

Vor dem ersten Laden für **jedes Rad einmal die Ladekurve aufzeichnen** (App → Zahnrad → Ladekurven): Akku möglichst leer fahren,
Stand vom Fahrrad-Display eintragen, Aufzeichnung starten und bis zum Ende laden lassen.

### Umstieg vom Supercharge-Skript

Im Reiter „Räder“ den Datenpunkt-Ordner des Skripts eintragen (z. B. `0_userdata.0.SuperchargeDuo`), speichern und
**Ladekurven übernehmen** drücken. Übernommen werden je Rad `<Ordner>.<Name>.Kurve` (bzw. `<Ordner>.Kurve`), der Startwert der
Aufzeichnung und – wenn hier noch leer – die Statistik. Danach das Skript stoppen.

## Die App

**`http://<ioBroker-IP>:8095/`** – vom eigenen Webserver des Adapters (Port im Reiter „App“). Ist dort ein Passwort gesetzt,
wird es einmal in der App unter Zahnrad → „App-Passwort“ eingegeben. Auf dem Handy über „Zum Home-Bildschirm“ als Symbol ablegen.

Mit Datenquelle **simple-api** holt die App ihre Daten über die gewählte simple-api-Instanz. Ist der eigene Webserver
ausgeschaltet, ist die App über den web-Adapter erreichbar: `http://<ioBroker-IP>:8082/supercharge/index.html`
(Daten dann immer über simple-api auf demselben Rechner, Port 8087 – in der App über das Zahnrad änderbar).

Die Schnittstelle des eigenen Webservers kennt nur die Datenpunkte von Supercharge: lesen über `GET /api/zustand`,
schreiben (nur Ziel, Fertig-Uhrzeit, Modus, Startwert, Hinweis und die Knöpfe) über `POST /api/set` mit `{"key":"rad1.ZielSOC","value":80}`.

## Datenpunkte

| Datenpunkt | Bedeutung |
|---|---|
| `info.konfig` | Räder, Farben, Ziele und Backup für die App (JSON) |
| `Statistik` | letzte 100 Ladevorgänge aller Räder (JSON) |
| `radN.ZielSOC`, `radN.FertigBis`, `radN.Modus` | Ziel (%), Fertig-Uhrzeit „HH:MM“ bei 100 %, `laden`/`aufzeichnen` |
| `radN.Start`, `radN.Abbruch`, `radN.JetztVoll` | Knöpfe |
| `radN.SOC`, `radN.Status`, `radN.Laeuft`, `radN.Phase`, `radN.RestMinuten`, `radN.Leistung` | Zustand |
| `radN.Kurve`, `radN.StartSOCAufz` | Ladekurve und Startwert der Aufzeichnung |
| `radN.Plan`, `radN.Verlauf`, `radN.Hinweis`, `radN.Sitzung` | für App und Neustart |

Die Knöpfe lassen sich auch aus Skripten, Blockly oder VIS setzen (`setState('supercharge.0.rad1.Start', true)`).

## Changelog

### 0.2.0 (2026-10-25)
- Eigener Webserver für die App: web- und simple-api-Adapter werden nicht mehr benötigt
- Optionales App-Passwort
- Datenquelle der App im Reiter „App“ wählbar: eigener Webserver oder simple-api (Instanz, Adresse)

### 0.1.0 (2026-10-25)
- Erste Version: 1–4 Räder, Ladekurve je Rad, Fertig-Uhrzeit, Backup-Zeitfenster mit Wochentagen, Fortsetzen nach Neustart,
  Übernahme aus dem Skript, Web-App

## License

MIT License – Copyright (c) 2026 Andreas Voigtländer
