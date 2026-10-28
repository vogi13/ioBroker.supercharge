'use strict';
/**
 * Simulator mit virtueller Uhr für die Ladelogik (lib/rad.js + lib/planung.js).
 * Ein „Adapter-Neustart“ erzeugt neue Rad-Instanzen auf denselben gespeicherten Datenpunkten.
 */
const { Rad } = require('../lib/rad');
const { planung } = require('../lib/planung');

const RealDate = Date;
let jetzt = 0;
class FakeDate extends RealDate {
    constructor(...a) { if (a.length) super(...a); else super(jetzt); }
    static now() { return jetzt; }
}
const pad = x => String(x).padStart(2, '0');
const hm = ms => { const d = new RealDate(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };

// Ladegeräte: schnelles (~180 W) und langsames (~85 W)
const LADER = {
    schnell: soc => soc >= 100 ? 0.8 : soc < 80 ? 165 + (soc - 10) * 0.3 : 186 * Math.exp(-(soc - 80) / 8),
    langsam: soc => soc >= 100 ? 0.6 : soc < 85 ? 78 + (soc - 10) * 0.12 : 87 * Math.exp(-(soc - 85) / 5),
    // schnelles Ladegerät bei Kälte: weniger Leistung, Abfall beginnt früher
    kalt: soc => soc >= 100 ? 0.8 : soc < 74 ? 140 + (soc - 10) * 0.4 : 165.6 * Math.exp(-(soc - 74) / 9),
};
function kurve(lader) {
    const k = [], ps = []; let soc = 10;
    while (soc < 100) { ps.push(lader(soc)); soc += lader(soc) / 60 / 500 * 100; }
    const ges = ps.reduce((a, c) => a + c, 0); let e = 0;
    for (const p of ps) { e += p; k.push({ p: Math.round(p * 10) / 10, soc: Math.round(10 + e / ges * 90) }); }
    return JSON.stringify(k);
}

const STANDARD = { minLeistung: 3, maxLadezeitMin: 720, sitzungMaxMin: 60, parkSoc: 80, pufferMin: 20, minPauseMin: 15 };

/**
 * @param {object} p
 *  raeder: [{ id, name, lader: 'schnell'|'langsam', akku, ziel, fertigBis, angesteckt }]
 *  start, bis (ms), backup: Konfig für planung, ausfall: [[t, dauerMs]] (Adapter aus), aktion: [[t, fn(welt)]]
 */
function lauf(p) {
    global.Date = FakeDate;
    try {
        jetzt = p.start;
        const W = { states: {}, an: {}, akku: {}, angesteckt: {}, ereignisse: [], log: [] };
        const opt = { ...STANDARD, tempSchwelle: 12, temperatur: () => (p.temp === undefined ? null : p.temp), ...(p.opt || {}), plan: planung(p.backup) };
        for (const r of p.raeder) {
            W.akku[r.id] = r.akku; W.an[r.id] = false; W.angesteckt[r.id] = r.angesteckt !== false;
            Object.assign(W.states, {
                [`${r.id}.Kurve`]: r.sommer === null ? '[]' : kurve(LADER[r.sommer || r.lader]),
                [`${r.id}.KurveWinter`]: r.winter ? kurve(LADER[r.winter]) : '[]', [`${r.id}.KurvenInfo`]: '{}', [`${r.id}.AufzArt`]: r.aufzArt || 'sommer',
                [`${r.id}.ZielSOC`]: r.ziel, [`${r.id}.FertigBis`]: r.fertigBis || '',
                [`${r.id}.Modus`]: r.modus || 'laden', [`${r.id}.StartSOCAufz`]: 10, [`${r.id}.SOC`]: 0, [`${r.id}.Verlauf`]: '[]', [`${r.id}.Sitzung`]: '',
            });
        }
        W.states.Statistik = '[]';
        const leistung = id => (W.an[id] && W.angesteckt[id] ? LADER[p.raeder.find(r => r.id === id).lader](W.akku[id]) : 0);

        function instanz() {
            const intervals = new Map(), timeouts = new Map(); let nid = 0;
            const env = {
                get: k => W.states[k],
                set: (k, v) => {
                    W.states[k] = v;
                    if (k.endsWith('.Status')) W.ereignisse.push(`${hm(jetzt)} ${k.split('.')[0]}: ${v}`);
                },
                getF: fid => {
                    const [id, art] = fid.split('/');
                    return art === 'P' ? leistung(id) : W.an[id];
                },
                setF: (fid, v) => {
                    const id = fid.split('/')[0];
                    if (W.an[id] !== v) W.ereignisse.push(`${hm(jetzt)} ${id} Steckdose ${v ? 'EIN' : 'AUS'}`);
                    W.an[id] = v;
                },
                log: { info: t => W.log.push(`${hm(jetzt)} ${t}`), warn: t => W.log.push(`${hm(jetzt)} WARN ${t}`) },
                setInterval: f => { intervals.set(++nid, f); return nid; }, clearInterval: i => intervals.delete(i),
                setTimeout: (f, ms) => { timeouts.set(++nid, { f, at: jetzt + ms }); return nid; }, clearTimeout: i => timeouts.delete(i),
            };
            const raeder = p.raeder.map(r => Rad(env, { id: r.id, name: r.name || r.id, schalter: `${r.id}/S`, leistung: `${r.id}/P` }, opt));
            raeder.forEach(r => r.init());
            return {
                raeder,
                rad: id => raeder.find(r => r.id === id),
                schritt() {
                    for (const f of [...intervals.values()]) f();
                    for (const [k, t] of [...timeouts]) if (t.at <= jetzt) { timeouts.delete(k); t.f(); }
                },
                stoppen() { raeder.forEach(r => r.stopp()); intervals.clear(); timeouts.clear(); },
            };
        }

        let inst = instanz(), unten = null;
        W.inst = () => inst;
        while (jetzt < p.bis) {
            for (const [t, f] of p.aktion || []) if (inst && jetzt >= t && jetzt < t + 10000) f(W, inst);
            for (const [t, dauer] of p.ausfall || []) {
                if (!unten && inst && jetzt >= t && jetzt < t + 10000) { W.ereignisse.push(`${hm(jetzt)} === Adapter aus ===`); inst.stoppen(); inst = null; unten = t + dauer; }
            }
            if (unten && jetzt >= unten) { W.ereignisse.push(`${hm(jetzt)} === Adapter startet ===`); inst = instanz(); unten = null; }
            if (inst) inst.schritt();
            for (const r of p.raeder) {
                const P = leistung(r.id);
                if (P > 0) W.akku[r.id] = Math.min(100.5, W.akku[r.id] + P * (10 / 3600) / 500 * 100);
            }
            jetzt += 10000;
        }
        W.statistik = JSON.parse(W.states.Statistik);
        return W;
    } finally {
        global.Date = RealDate;
    }
}
const t = (tag, h, m) => new RealDate(2026, 9, tag, h, m).getTime();   // Oktober 2026 (18. = Sonntag)
module.exports = { lauf, t, hm };
