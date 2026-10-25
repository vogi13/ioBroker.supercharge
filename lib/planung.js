'use strict';
/**
 * Zeitplanung für „100 % mit Fertig-Uhrzeit“: Backup-Sperrfenster, nutzbare Lademinuten,
 * spätester Wiederstart und voraussichtliches Ende.
 * Dieselben Regeln stecken (vereinfacht) auch in der App (www/index.html).
 */
const MIN = 60000;

/**
 * @param {object} backup { aktiv, start: 'HH:MM', dauer, vorher, nachher, tage: [So, Mo, …, Sa] (boolean) }
 */
function planung(backup) {
    const b = backup || {};
    const m = /^(\d{1,2}):(\d{2})/.exec(String(b.start || ''));
    const aktiv = !!b.aktiv && !!m;
    const bh = m ? +m[1] : 0, bm = m ? +m[2] : 0;
    const tage = Array.isArray(b.tage) && b.tage.length === 7 ? b.tage : [true, true, true, true, true, true, true];

    /** Sperrfenster [von, bis, beginn] (ms), die den Zeitraum a..b berühren */
    function sperrfenster(a, z) {
        if (!aktiv) return [];
        const out = [];
        const tag = new Date(a); tag.setHours(0, 0, 0, 0); tag.setDate(tag.getDate() - 1);
        while (tag.getTime() <= z + 864e5) {
            if (tage[tag.getDay()]) {
                const t = new Date(tag); t.setHours(bh, bm, 0, 0);
                const von = t.getTime() - (Number(b.vorher) || 0) * MIN;
                const bis = t.getTime() + ((Number(b.dauer) || 0) + (Number(b.nachher) || 0)) * MIN;
                if (bis > a && von < z) out.push([von, bis, t.getTime()]);
            }
            tag.setDate(tag.getDate() + 1);
        }
        return out;
    }
    /** nutzbare Lademinuten zwischen a und z (ohne Sperrfenster) */
    function lademinuten(a, z) {
        if (z <= a) return 0;
        const gesperrt = sperrfenster(a, z).reduce((s, [v, w]) => s + Math.max(0, Math.min(z, w) - Math.max(a, v)), 0);
        return (z - a - gesperrt) / MIN;
    }
    /** spätester Start, damit bis "ende" noch "bedarf" Minuten geladen werden können */
    function spaetesterStart(ende, bedarf) {
        let start = ende - bedarf * MIN;
        for (let i = 0; i < 8; i++) {
            const fehlt = bedarf - lademinuten(start, ende);
            if (fehlt <= 0.5) break;
            start -= fehlt * MIN;
        }
        const drin = sperrfenster(start, start + 1).find(([v, w]) => start >= v && start < w);
        return drin ? drin[0] : start;   // nie mitten im Backup starten
    }
    /** Ende, wenn ab "start" noch "bedarf" Minuten geladen werden */
    function endeAb(start, bedarf) {
        let ende = start + bedarf * MIN;
        for (let i = 0; i < 8; i++) {
            const fehlt = bedarf - lademinuten(start, ende);
            if (fehlt <= 0.5) break;
            ende += fehlt * MIN;
        }
        return ende;
    }
    return { sperrfenster, lademinuten, spaetesterStart, endeAb };
}

/** "HH:MM" -> nächster Zeitpunkt in der Zukunft (ms) */
function naechsteUhrzeit(hhmm) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
    if (!m) return null;
    const d = new Date(); d.setHours(+m[1], +m[2], 0, 0);
    if (d.getTime() <= Date.now() + 10 * MIN) d.setDate(d.getDate() + 1);
    return d.getTime();
}

const z2 = x => String(x).padStart(2, '0');
const uhr = ms => { const d = new Date(ms); return `${z2(d.getHours())}:${z2(d.getMinutes())}`; };
const datum = d => `${d.getFullYear()}-${z2(d.getMonth() + 1)}-${z2(d.getDate())} ${z2(d.getHours())}:${z2(d.getMinutes())}`;

module.exports = { planung, naechsteUhrzeit, uhr, datum, MIN };
