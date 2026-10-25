'use strict';
/**
 * Ladelogik für EIN Rad – übernommen aus dem Skript „Supercharge Duo Sommer“.
 * Der Ladestand (SOC) wird nur aus der Ladeleistung und ihrer Tendenz (CC/CV-Ladekurve)
 * geschätzt; beim Ziel wird die Steckdose abgeschaltet.
 *
 * Die Klasse kennt ioBroker nicht direkt, sondern spricht über "env":
 *   env.get(key) / env.set(key, val)      eigene Datenpunkte (relativ, z. B. "rad1.SOC"), synchron über einen Cache
 *   env.getF(id) / env.setF(id, val)      fremde Datenpunkte (Steckdose)
 *   env.log.info/warn, env.setInterval/clearInterval/setTimeout/clearTimeout
 */
const { naechsteUhrzeit, uhr, datum, MIN } = require('./planung');

const MESS_INTERVALL_S = 10;   // Messabstand in Sekunden
const LEER_MINUTEN = 3;        // so lange < MinLeistung => Ladegerät fertig
const TREND_FENSTER_MIN = 5;   // Vergleich mit Leistung vor x Minuten
const FALL_SCHWELLE_W = 1;     // Abfall um mind. x W gilt als "fallend"
const FALL_BESTAETIGUNG = 3;   // so viele Minuten in Folge fallend => CV-Phase
const GLAETTUNG_MIN = 3;       // Kurvenvergleich mit dem Mittel der letzten x Minuten
const SCHNELL_ABSTAND_W = 2;   // Start auf fallender Flanke: so weit unter der steigenden Flanke + fallend
const STATISTIK_MAX = 100;     // gespeicherte Ladevorgänge (alle Räder zusammen)

/** Datenpunkte je Rad */
const DP_RAD = {
    Kurve:        { def: '[]', type: 'string', role: 'json', name: 'Ladekurve dieses Rads (JSON: [{p,soc}], ein Eintrag pro Minute)' },
    StartSOCAufz: { def: 10, type: 'number', unit: '%', min: 0, max: 90, role: 'level', name: 'Ladestand beim Start der Aufzeichnung' },
    Modus:        { def: 'laden', type: 'string', role: 'text', name: 'Modus: aufzeichnen | laden', states: { aufzeichnen: 'aufzeichnen', laden: 'laden' } },
    ZielSOC:      { def: 80, type: 'number', unit: '%', min: 10, max: 100, role: 'level', name: 'Ziel-Ladestand' },
    FertigBis:    { def: '', type: 'string', role: 'text', name: 'Bei Ziel 100 %: voll bis Uhrzeit "HH:MM" (leer = ohne Unterbrechung)' },
    Start:        { def: false, type: 'boolean', role: 'button', name: 'Laden/Aufzeichnen starten' },
    Abbruch:      { def: false, type: 'boolean', role: 'button', name: 'Abbrechen' },
    JetztVoll:    { def: false, type: 'boolean', role: 'button', name: 'Pause beenden und sofort voll laden' },
    SOC:          { def: 0, type: 'number', unit: '%', role: 'value.battery', name: 'Geschätzter Ladestand', write: false },
    Status:       { def: 'bereit', type: 'string', role: 'text', name: 'Status', write: false },
    Flanke:       { def: '', type: 'string', role: 'text', name: 'Ladephase: steigend (CC) / fallend (CV)', write: false },
    Leistung:     { def: 0, type: 'number', unit: 'W', role: 'value.power', name: 'Aktuelle Leistung (Spiegel der Steckdose)', write: false },
    Laeuft:       { def: false, type: 'boolean', role: 'indicator', name: 'Ladevorgang aktiv (auch während einer Pause)', write: false },
    Phase:        { def: '', type: 'string', role: 'text', name: 'laden | pause | leer', write: false },
    Plan:         { def: '', type: 'string', role: 'json', name: 'Zeitplan für die App (JSON, Zeiten in ms)', write: false },
    Verlauf:      { def: '[]', type: 'string', role: 'json', name: 'Minutenleistungen des aktuellen/letzten Vorgangs (JSON)', write: false },
    StartSOC:     { def: -1, type: 'number', unit: '%', role: 'value', name: 'Geschätzter Ladestand beim Start des Vorgangs', write: false },
    Hinweis:      { def: '', type: 'string', role: 'text', name: 'Hinweis für die App (leer = keiner), z. B. kein Akku erkannt' },
    RestMinuten:  { def: -1, type: 'number', unit: 'min', role: 'value', name: 'Geschätzte reine Ladezeit bis zum Ziel (-1 = unbekannt)', write: false },
    Sitzung:      { def: '', type: 'string', role: 'json', name: 'Interner Zustand zum Fortsetzen nach Neustart', write: false },
};
const BUTTONS = ['Start', 'Abbruch', 'JetztVoll'];

/**
 * @param {object} env  Schnittstelle zu ioBroker (siehe oben)
 * @param {object} cfg  { id: 'rad1', name, schalter, leistung }
 * @param {object} opt  { minLeistung, maxLadezeitMin, sitzungMaxMin, parkSoc, pufferMin, minPauseMin, plan }
 */
function Rad(env, cfg, opt) {
    const name = cfg.name;
    const id = key => `${cfg.id}.${key}`;
    const val = key => env.get(id(key));
    const set = (key, v) => env.set(id(key), v);
    const schalten = an => env.setF(cfg.schalter, an);
    const log = txt => env.log.info(`${name}: ${txt}`);
    const status = txt => { set('Status', txt); log(txt); };
    const { spaetesterStart, endeAb } = opt.plan;
    const PARK_SOC = opt.parkSoc, PUFFER_MIN = opt.pufferMin, MIN_PAUSE_MIN = opt.minPauseMin;
    let s = null;            // aktiver Ladevorgang
    let takt = null;         // Mess-Intervall
    let weiterTimer = null;  // Ende der Pause
    let stoppt = false;

    function statistikEintragen(eintrag) {
        let st = [];
        try { st = JSON.parse(env.get('Statistik')) || []; } catch (e) { /* leer */ }
        st.unshift(eintrag);
        env.set('Statistik', JSON.stringify(st.slice(0, STATISTIK_MAX)));
    }
    function ladeKurve() {
        try {
            const k = JSON.parse(val('Kurve'));
            return Array.isArray(k) && k.length >= 10 ? k : null;
        } catch (e) { return null; }
    }
    function kurveVorbereiten(ziel, kurve) {
        ziel.kurve = kurve;
        ziel.peakIdx = kurve.reduce((bi, k, i) => (k.p > kurve[bi].p ? i : bi), 0);
        ziel.peakSOC = kurve[ziel.peakIdx].soc;
        ziel.minSteigend = Math.min(...kurve.slice(Math.min(2, ziel.peakIdx), ziel.peakIdx + 1).map(k => k.p));
    }

    /** SOC aus Minutenleistung: gleiche Leistung kommt auf steigender (CC) und fallender (CV) Flanke vor – die Tendenz entscheidet */
    function socBestimmen(P) {
        const m = s.minuten, n = m.length, imAbschnitt = n - s.abschnitt;
        if (s.seite === 'steigend') {
            const trend = imAbschnitt > TREND_FENSTER_MIN ? P - m[n - 1 - TREND_FENSTER_MIN] : 0;
            s.fallZaehler = trend <= -FALL_SCHWELLE_W ? s.fallZaehler + 1 : 0;
            const schnell = imAbschnitt >= 3 && P < s.minSteigend - SCHNELL_ABSTAND_W && P < m[n - 3] - SCHNELL_ABSTAND_W;
            if (s.fallZaehler >= FALL_BESTAETIGUNG || schnell) {
                s.seite = 'fallend';
                if (n <= 12 && s.abschnitt === 0) s.startNeu = true;   // Start lag schon auf der fallenden Flanke
                log(`fallende Flanke erkannt nach ${n} min (${Math.round(P)} W)`);
            }
            set('Flanke', s.seite);
        }
        const fenster = m.slice(Math.max(s.abschnitt, n - GLAETTUNG_MIN));
        const Pg = fenster.reduce((a, b) => a + b, 0) / fenster.length;
        const [von, bis] = s.seite === 'fallend' ? [s.peakIdx, s.kurve.length - 1] : [0, s.peakIdx];
        let best = von, bestDiff = Infinity;
        for (let i = von; i <= bis; i++) {
            const d = Math.abs(s.kurve[i].p - Pg);
            if (d < bestDiff) { bestDiff = d; best = i; }
        }
        const soc = s.kurve[best].soc;
        if (s.startNeu) { s.startNeu = false; s.startSOC = soc; return soc; }
        return Math.max(s.soc, soc);   // SOC kann beim Laden nicht sinken
    }

    /** reine Ladezeit in Minuten vom aktuellen SOC (oder "abSoc") bis zum Ziel */
    function restMinutenBerechnen(ziel, abSoc = s.soc) {
        const k = s.kurve;
        const jetzt = k.findIndex(e => e.soc >= abSoc);
        if (jetzt < 0) return 1;
        let zielIdx = ziel >= 100 ? k.length : k.findIndex(e => e.soc >= ziel);
        if (zielIdx < 0) zielIdx = k.length;
        if (ziel < 100 && ziel >= s.peakSOC - 3) zielIdx = Math.max(zielIdx, s.peakIdx + FALL_BESTAETIGUNG + 2);
        return Math.max(1, zielIdx - jetzt + (ziel >= 100 ? 1 : 0));   // +1: Anlauf nach der Pause
    }

    function kurveSpeichern() {
        const m = s.minuten;
        const gesamt = m.reduce((a, b) => a + b, 0);
        if (m.length < 10 || gesamt <= 0) { status('Aufzeichnung zu kurz – nichts gespeichert'); return; }
        const startA = Number(val('StartSOCAufz')) || 0;
        let e = 0;
        const kurve = m.map(p => {
            e += p;
            return { p: Math.round(p * 10) / 10, soc: Math.round(startA + (e / gesamt) * (100 - startA)) };
        });
        set('Kurve', JSON.stringify(kurve));
        log(`Ladekurve gespeichert (${m.length} min, ${Math.round(gesamt / 60)} Wh)`);
    }

    // ---------- Zustand sichern / Plan veröffentlichen ----------
    function sichern() {
        if (!s) return set('Sitzung', '');
        const { modus, soc, startSOC, seite, phase, zielMs, weiterMs, pauseAbMs, fertigMs, startMs, planErledigt, socVorher, verlaufVorher } = s;
        set('Sitzung', JSON.stringify({ v: 1, gesichert: Date.now(), modus, soc, startSOC, seite, phase,
            zielMs, weiterMs, pauseAbMs, fertigMs, startMs, planErledigt, socVorher, verlaufVorher }));
    }
    function planVeroeffentlichen() {
        if (!s) return set('Plan', '');
        const mitPlan = !!s.zielMs && (!s.planErledigt || s.phase === 'pause');
        set('Plan', JSON.stringify({
            ziel: s.zielMs || null, park: PARK_SOC, puffer: PUFFER_MIN, start: s.startMs,
            pauseAb: s.pauseAbMs || null, weiter: mitPlan ? s.weiterMs || null : null,
            fertig: s.fertigMs || null, aktiv: mitPlan,
        }));
    }
    function phaseSetzen(p) { if (s) s.phase = p; set('Phase', p); }
    function taktStarten() { takt = env.setInterval(messen, MESS_INTERVALL_S * 1000); }
    function taktStoppen() { if (takt) env.clearInterval(takt); takt = null; }
    function weiterStoppen() { if (weiterTimer) env.clearTimeout(weiterTimer); weiterTimer = null; }

    // ---------- Ablauf ----------
    function starten() {
        if (s) return;
        const modus = val('Modus');
        const neu = { modus, minuten: [], summe: 0, anzahl: 0, leer: 0, seite: 'steigend', fallZaehler: 0, soc: -1, startSOC: null,
            abschnitt: 0, phase: 'laden', startMs: Date.now(), zielMs: null, weiterMs: null, pauseAbMs: null, fertigMs: null, planErledigt: false };

        if (modus === 'laden') {
            const kurve = ladeKurve();
            if (!kurve) {
                status('Fehler: noch keine Ladekurve – zuerst in den Einstellungen aufzeichnen');
                schalten(false);
                return;
            }
            kurveVorbereiten(neu, kurve);
            if (Number(val('ZielSOC')) >= 100) neu.zielMs = naechsteUhrzeit(val('FertigBis'));
        } else if (modus !== 'aufzeichnen') {
            status(`Fehler: unbekannter Modus "${modus}"`);
            return;
        }

        set('Hinweis', '');
        neu.socVorher = val('SOC');            // für den Fall „kein Akku“
        neu.verlaufVorher = val('Verlauf');
        s = neu;
        set('Laeuft', true);
        phaseSetzen('laden');
        set('Flanke', modus === 'laden' ? 'steigend' : '');
        set('Verlauf', '[]');
        set('RestMinuten', -1);
        set('StartSOC', modus === 'aufzeichnen' ? Number(val('StartSOCAufz')) : -1);
        if (modus === 'laden') set('SOC', 0);
        schalten(true);
        const zielTxt = s.zielMs ? `Ziel 100 % bis ${uhr(s.zielMs)}` : `Ziel ${val('ZielSOC')} %`;
        status(modus === 'laden' ? `läuft (laden), ${zielTxt}` : 'läuft (aufzeichnen)');
        taktStarten();
        sichern(); planVeroeffentlichen();
    }

    function messen() {
        if (!s || s.phase !== 'laden') return;
        s.summe += Number(env.getF(cfg.leistung)) || 0;
        s.anzahl++;
        if (s.anzahl * MESS_INTERVALL_S >= 60) {
            const P = s.summe / s.anzahl;
            s.summe = 0; s.anzahl = 0;
            minuteAuswerten(P);
        }
    }

    function minuteAuswerten(P) {
        s.minuten.push(P);
        set('Verlauf', JSON.stringify(s.minuten.map(x => Math.round(x * 10) / 10)));
        const minL = opt.minLeistung;
        s.leer = P < minL ? s.leer + 1 : 0;

        if (s.leer >= LEER_MINUTEN) {
            // Hat das Ladegerät nie Leistung aufgenommen, war kein Akku angesteckt (oder er war schon voll)
            if (s.minuten.every(x => x < minL)) return keineLadung();
            // nach einer Pause/einem Neustart kommt keine Leistung mehr: Akku vermutlich abgesteckt
            if (s.abschnitt > 0 && s.minuten.slice(s.abschnitt).every(x => x < minL) && s.soc < 95) {
                s.minuten.splice(-LEER_MINUTEN);
                return beenden('Nach der Pause keine Ladeleistung – Akku abgesteckt?');
            }
            s.minuten.splice(-LEER_MINUTEN);
            if (s.modus === 'aufzeichnen') kurveSpeichern();
            s.soc = 100;
            if (s.startSOC === null && s.modus === 'aufzeichnen') s.startSOC = Number(val('StartSOCAufz'));
            return beenden('Ladegerät fertig, Akku voll');
        }
        if (s.minuten.length >= opt.maxLadezeitMin) return beenden(`Sicherheitsabschaltung nach ${Math.round(opt.maxLadezeitMin / 6) / 10} h`);
        if (P < minL) { sichern(); return; }            // ohne Ladeleistung keine Ladestand-Schätzung

        if (s.modus === 'laden') {
            s.soc = socBestimmen(P);
            if (s.startSOC === null) s.startSOC = s.soc;
            set('SOC', s.soc);
            set('StartSOC', s.startSOC);
            const ziel = Number(val('ZielSOC'));
            const rest = restMinutenBerechnen(ziel);
            set('RestMinuten', rest);

            // Fertig-Uhrzeit: bei PARK_SOC pausieren, wenn bis zum spätesten Wiederstart genug Zeit ist
            if (ziel >= 100 && s.zielMs && !s.planErledigt) {
                const bedarf = restMinutenBerechnen(100, Math.max(s.soc, PARK_SOC));
                s.weiterMs = spaetesterStart(s.zielMs - PUFFER_MIN * MIN, bedarf);
                s.fertigMs = endeAb(Math.max(Date.now(), s.weiterMs), bedarf);
                if (s.soc >= PARK_SOC) {
                    if (s.weiterMs - Date.now() >= MIN_PAUSE_MIN * MIN) { planVeroeffentlichen(); return pausieren(); }
                    s.planErledigt = true;   // keine Zeit für eine Pause – durchladen
                    log('keine Pause nötig/möglich – lade durch');
                }
            } else {
                s.fertigMs = endeAb(Date.now(), rest);
            }
            planVeroeffentlichen();

            // Ziel nahe am Flankenwechsel: erst bestätigte CV-Phase abwarten
            const sicher = s.seite === 'fallend' || ziel < s.peakSOC - 3;
            if (ziel < 100 && s.soc >= ziel && sicher) return beenden(`Ziel ${ziel} % erreicht`);
        }
        sichern();
    }

    function pausieren() {
        taktStoppen();
        s.summe = 0; s.anzahl = 0; s.leer = 0;
        s.pauseAbMs = Date.now();
        phaseSetzen('pause');                 // zuerst Phase setzen, damit der Schalt-Listener das Aus ignoriert
        schalten(false);
        set('RestMinuten', -1);
        status(`pausiert bei ${s.soc} % – lädt weiter um ${uhr(s.weiterMs)}, voll ca. ${uhr(s.fertigMs)}`);
        weiterPlanen();
        sichern(); planVeroeffentlichen();
    }
    function weiterPlanen() {
        weiterStoppen();
        const warten = Math.max(1000, s.weiterMs - Date.now());
        // lange Wartezeiten in Etappen (setTimeout verträgt max. ~24,8 Tage, und so bleibt es robust gegen Zeitsprünge)
        weiterTimer = env.setTimeout(() => {
            weiterTimer = null;
            if (!s || s.phase !== 'pause') return;
            if (s.weiterMs - Date.now() > 1000) return weiterPlanen();
            fortsetzen('Pause beendet');
        }, Math.min(warten, 3600 * 1000));
    }
    function fortsetzen(grund) {
        if (!s || s.phase !== 'pause') return;
        weiterStoppen();
        s.planErledigt = true;
        s.abschnitt = s.minuten.length;      // neuer Abschnitt: Trend nicht mit Werten vor der Pause vergleichen
        s.fallZaehler = 0; s.leer = 0; s.summe = 0; s.anzahl = 0;
        phaseSetzen('laden');
        schalten(true);
        s.fertigMs = endeAb(Date.now(), restMinutenBerechnen(100));
        status(`lädt weiter bis 100 % (${grund}), voll ca. ${uhr(s.fertigMs)}`);
        taktStarten();
        sichern(); planVeroeffentlichen();
    }

    /** Abbruch ohne Ladung: nichts in die Statistik, alten Ladestand wiederherstellen */
    function keineLadung() {
        taktStoppen(); weiterStoppen();
        const alt = s;
        schalten(false);
        s = null;   // erst nach dem Ausschalten zurücksetzen
        set('SOC', alt.socVorher ?? 0);
        set('Verlauf', alt.verlaufVorher ?? '[]');
        aufraeumen(alt);
        set('Hinweis', 'Letzter Start abgebrochen: keine Ladeleistung – kein Akku angesteckt oder Akku schon voll.');
        status('Keine Ladeleistung – kein Akku angesteckt oder Akku schon voll. Nichts geladen.');
    }

    function beenden(grund, ausschalten = true) {
        if (!s) return;
        taktStoppen(); weiterStoppen();
        const alt = s;
        if (ausschalten) schalten(false);
        if (alt.modus === 'laden') set('SOC', alt.soc);
        statistikEintragen({
            rad: cfg.id,
            name,
            datum: datum(new Date()),
            modus: alt.modus,
            startSOC: alt.startSOC,
            endSOC: alt.soc,
            minuten: alt.minuten.length,
            wh: Math.round(alt.minuten.reduce((a, b) => a + b, 0) / 60),
            grund: alt.zielMs ? `${grund} (Ziel ${uhr(alt.zielMs)})` : grund,
        });
        s = null;   // erst nach dem Ausschalten zurücksetzen, sonst triggert der Schalt-Listener
        aufraeumen(alt);
        const soc = alt.modus === 'laden' && alt.startSOC !== null && alt.soc >= 0 ? ` | SOC ${alt.startSOC} % → ${alt.soc} %` : '';
        status(`${grund}${soc} | ${alt.minuten.length} min`);
    }
    function aufraeumen(alt) {
        set('Laeuft', false);
        set('Phase', '');
        set('RestMinuten', -1);
        set('Plan', '');
        set('Sitzung', '');
        if (!alt || alt.modus === 'aufzeichnen' || alt.soc < 0) set('StartSOC', -1);
        set('Flanke', '');
        if (alt && alt.modus === 'aufzeichnen') set('Modus', 'laden');
    }

    /** nach Neustart: gespeicherte Sitzung fortsetzen */
    function wiederherstellen() {
        let z = null;
        try { z = JSON.parse(val('Sitzung') || 'null'); } catch (e) { /* nichts */ }
        if (!z || z.v !== 1) return false;
        const alter = (Date.now() - z.gesichert) / MIN;
        if (alter > opt.sitzungMaxMin && z.phase !== 'pause') {
            status(`Ladevorgang nach Neustart nicht fortgesetzt (Unterbrechung ${Math.round(alter)} min zu lang)`);
            return false;
        }
        const neu = { ...z, minuten: [], summe: 0, anzahl: 0, leer: 0, fallZaehler: 0, startNeu: false };
        try { neu.minuten = (JSON.parse(val('Verlauf')) || []).map(Number); } catch (e) { /* leer */ }
        neu.abschnitt = neu.minuten.length;
        if (neu.modus === 'laden') {
            const kurve = ladeKurve();
            if (!kurve) return false;
            kurveVorbereiten(neu, kurve);
        }
        s = neu;
        set('Laeuft', true);
        if (s.phase === 'pause') {
            schalten(false);
            phaseSetzen('pause');
            if (s.weiterMs <= Date.now()) fortsetzen('nach Neustart, Zeit erreicht');
            else { weiterPlanen(); status(`pausiert bei ${s.soc} % – lädt weiter um ${uhr(s.weiterMs)} (nach Neustart)`); }
        } else {
            phaseSetzen('laden');
            schalten(true);
            taktStarten();
            status(`${s.modus === 'aufzeichnen' ? 'Aufzeichnung' : 'Ladevorgang'} nach Neustart fortgesetzt`);
        }
        sichern(); planVeroeffentlichen();
        return true;
    }

    // ---------- Schnittstelle für den Adapter ----------
    return {
        id: cfg.id, name, cfg,
        /** nach dem Laden des Caches aufrufen */
        init() {
            if (!wiederherstellen()) {
                if (env.getF(cfg.schalter) === true) {
                    schalten(false);
                    set('Status', 'Adapter neu gestartet – Ladevorgang abgebrochen');
                }
                aufraeumen(null);
            }
        },
        /** Befehl aus der App/aus ioBroker (Start, Abbruch, JetztVoll) */
        befehl(key) {
            if (key === 'Start') starten();
            else if (key === 'Abbruch') beenden('manuell abgebrochen');
            else if (key === 'JetztVoll') {
                if (!s) return;
                if (s.phase === 'pause') fortsetzen('sofort gewünscht');
                else { s.planErledigt = true; planVeroeffentlichen(); sichern(); status('lädt ohne Pause bis 100 %'); }
            }
        },
        /** Schalten an der Steckdose (Taste, Shelly-App): Ein startet bzw. beendet die Pause, Aus bricht ab */
        schalterGeaendert(an) {
            if (stoppt) return;
            if (an) {
                if (!s) starten();
                else if (s.phase === 'pause') fortsetzen('an der Steckdose eingeschaltet');
            } else if (s && s.phase === 'laden') beenden('an der Steckdose ausgeschaltet', false);
        },
        leistungGeaendert(w) { set('Leistung', Math.round((Number(w) || 0) * 10) / 10); },
        /** Adapter stoppt: Ausgang abschalten, Sitzung bleibt gespeichert */
        stopp() {
            stoppt = true;
            taktStoppen(); weiterStoppen();
            if (s) { sichern(); if (s.phase === 'laden') schalten(false); }
        },
        /** nur für Tests */
        _zustand: () => s,
    };
}

module.exports = { Rad, DP_RAD, BUTTONS };
