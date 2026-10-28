'use strict';
const assert = require('assert');
const { lauf, t, hm } = require('./sim');

const BACKUP = { aktiv: true, start: '04:30', dauer: 10, vorher: 5, nachher: 10, tage: [true, true, true, true, true, true, true] };
const zeig = W => `\n${W.ereignisse.join('\n')}\n--- Log ---\n${W.log.slice(-15).join('\n')}`;
const start = id => (W, inst) => inst.rad(id).befehl('Start');
const zeitVon = (W, muster) => { const e = W.ereignisse.find(x => muster.test(x)); return e ? e.slice(0, 5) : null; };

describe('Supercharge Ladelogik (Simulation)', function () {
    this.timeout(60000);

    it('A: 100 % bis 06:45 mit Backup 04:30 – Pause bei 80 %, voll vor 06:45, Neustart wird überbrückt', () => {
        const W = lauf({ start: t(18, 22, 0), bis: t(19, 7, 15), backup: BACKUP, ausfall: [[t(19, 4, 30), 20 * 60000]],
            raeder: [{ id: 'rad1', name: 'Jutta', lader: 'schnell', akku: 30, ziel: 100, fertigBis: '06:45' }],
            aktion: [[t(18, 22, 0), start('rad1')]] });
        const txt = zeig(W);
        assert.ok(W.ereignisse.some(e => /pausiert bei 8\d %/.test(e)), 'keine Pause' + txt);
        assert.ok(W.ereignisse.some(e => /nach Neustart fortgesetzt|lädt weiter/.test(e)), 'nicht fortgesetzt' + txt);
        const voll = zeitVon(W, /Ladegerät fertig, Akku voll/);
        assert.ok(voll && voll <= '06:45', `nicht rechtzeitig voll (${voll})` + txt);
        assert.ok(W.akku.rad1 >= 99, 'Akku nicht voll' + txt);
    });

    it('B/C: Sperrfenster verschiebt den Wiederstart – nur an aktiven Wochentagen', () => {
        const fall = backup => lauf({ start: t(18, 23, 0), bis: t(19, 6, 0), backup,
            raeder: [{ id: 'rad1', lader: 'schnell', akku: 40, ziel: 100, fertigBis: '05:30' }],
            aktion: [[t(18, 23, 0), start('rad1')]] });
        const mit = fall(BACKUP);
        const ohneTag = fall({ ...BACKUP, tage: [true, false, true, true, true, true, true] });   // Montag (19.10.) kein Backup
        const ohne = fall({ ...BACKUP, aktiv: false });
        const w = W => zeitVon(W, /lädt weiter bis 100 %/);
        const min = s => +s.slice(0, 2) * 60 + +s.slice(3);
        assert.ok(w(mit) && w(ohne), zeig(mit) + zeig(ohne));
        const diff = min(w(ohne)) - min(w(mit));
        assert.ok(diff >= 20 && diff <= 30, `Backup verschiebt um ${diff} min (erwartet ~25)` + zeig(mit) + zeig(ohne));
        assert.strictEqual(w(ohneTag), w(ohne), 'inaktiver Wochentag darf nichts verschieben' + zeig(ohneTag));
        const voll = zeitVon(mit, /Ladegerät fertig/);
        assert.ok(voll <= '05:30', `voll erst ${voll}` + zeig(mit));
    });

    it('D: normal auf 80 % – stoppt bei 80 %, Statistik mit Rad-ID und Name', () => {
        const W = lauf({ start: t(19, 17, 0), bis: t(19, 22, 0),
            raeder: [{ id: 'rad2', name: 'Werner', lader: 'langsam', akku: 30, ziel: 80 }],
            aktion: [[t(19, 17, 0), start('rad2')]] });
        assert.ok(W.ereignisse.some(e => /Ziel 80 % erreicht/.test(e)), zeig(W));
        assert.ok(W.akku.rad2 >= 77 && W.akku.rad2 <= 86, `Akku ${W.akku.rad2}` + zeig(W));
        assert.strictEqual(W.statistik[0].rad, 'rad2');
        assert.strictEqual(W.statistik[0].name, 'Werner');
    });

    it('E: kein Akku angesteckt – Abbruch mit Hinweis, keine Statistik', () => {
        const W = lauf({ start: t(19, 17, 0), bis: t(19, 17, 20),
            raeder: [{ id: 'rad1', lader: 'schnell', akku: 30, ziel: 80, angesteckt: false }],
            aktion: [[t(19, 17, 0), start('rad1')]] });
        assert.ok(/kein Akku/.test(W.states['rad1.Hinweis']), zeig(W));
        assert.strictEqual(W.statistik.length, 0);
        assert.strictEqual(W.an.rad1, false);
    });

    it('F: vier Räder gleichzeitig mit unterschiedlichen Zielen', () => {
        const W = lauf({ start: t(19, 18, 0), bis: t(20, 1, 0),
            raeder: [
                { id: 'rad1', lader: 'schnell', akku: 25, ziel: 80 },
                { id: 'rad2', lader: 'langsam', akku: 40, ziel: 60 },
                { id: 'rad3', lader: 'schnell', akku: 50, ziel: 100 },
                { id: 'rad4', lader: 'langsam', akku: 15, ziel: 80 },
            ],
            aktion: ['rad1', 'rad2', 'rad3', 'rad4'].map(id => [t(19, 18, 0), start(id)]) });
        assert.ok(W.ereignisse.some(e => /rad1: Ziel 80 % erreicht/.test(e)), zeig(W));
        assert.ok(W.ereignisse.some(e => /rad2: Ziel 60 % erreicht/.test(e)), zeig(W));
        assert.ok(W.ereignisse.some(e => /rad3: Ladegerät fertig/.test(e)), zeig(W));
        assert.ok(W.ereignisse.some(e => /rad4: Ziel 80 % erreicht/.test(e)), zeig(W));
        assert.strictEqual(W.statistik.length, 4);
    });

    it('G: Pause bei eingestelltem Wert (70 %) und „Jetzt voll laden“', () => {
        const W = lauf({ start: t(18, 22, 0), bis: t(19, 3, 0), opt: { parkSoc: 70 },
            raeder: [{ id: 'rad1', lader: 'schnell', akku: 40, ziel: 100, fertigBis: '07:00' }],
            aktion: [[t(18, 22, 0), start('rad1')], [t(19, 1, 0), (W, inst) => inst.rad('rad1').befehl('JetztVoll')]] });
        assert.ok(W.ereignisse.some(e => /pausiert bei 7\d %/.test(e)), zeig(W));
        assert.ok(W.ereignisse.some(e => /^01:00 .*sofort gewünscht/.test(e)), zeig(W));
    });

    it('H: langer Ausfall während des Ladens (> 60 min) – wird nicht fortgesetzt', () => {
        const W = lauf({ start: t(19, 17, 0), bis: t(19, 20, 0),
            raeder: [{ id: 'rad1', lader: 'schnell', akku: 30, ziel: 80 }],
            ausfall: [[t(19, 17, 30), 90 * 60000]],
            aktion: [[t(19, 17, 0), start('rad1')]] });
        assert.ok(W.ereignisse.some(e => /nicht fortgesetzt/.test(e)), zeig(W));
        assert.strictEqual(W.an.rad1, false);
    });

    describe('Sommer- und Winterkurve', () => {
        const fall = (temp, rad) => lauf({ start: t(19, 17, 0), bis: t(19, 21, 0), temp,
            raeder: [{ id: 'rad1', lader: 'kalt', akku: 30, ziel: 80, ...rad }],
            aktion: [[t(19, 17, 0), start('rad1')]] });

        it('I: beide Kurven, 5 °C – Winterkurve, stoppt nahe 80 %', () => {
            const W = fall(5, { sommer: 'schnell', winter: 'kalt' });
            assert.strictEqual(W.states['rad1.AktiveKurve'], 'winter', zeig(W));
            assert.strictEqual(W.statistik[0].kurve, 'winter');
            assert.strictEqual(W.statistik[0].temp, 5);
            assert.ok(W.akku.rad1 >= 76 && W.akku.rad1 <= 85, `Akku ${W.akku.rad1.toFixed(1)}` + zeig(W));
        });
        it('I2: beide Kurven, 15 °C – Sommerkurve', () => {
            const W = fall(15, { sommer: 'schnell', winter: 'kalt', lader: 'schnell' });
            assert.strictEqual(W.states['rad1.AktiveKurve'], 'sommer', zeig(W));
        });
        it('I3: genau auf der Schwelle (12 °C) – Sommerkurve', () => {
            const W = fall(12, { sommer: 'schnell', winter: 'kalt', lader: 'schnell' });
            assert.strictEqual(W.states['rad1.AktiveKurve'], 'sommer');
        });
        it('J: nur Sommerkurve, 5 °C – Sommerkurve gilt trotzdem', () => {
            const W = fall(5, { sommer: 'schnell' });
            assert.strictEqual(W.states['rad1.AktiveKurve'], 'sommer', zeig(W));
            assert.ok(W.ereignisse.some(e => /Ziel 80 % erreicht/.test(e)), zeig(W));
        });
        it('K: nur Winterkurve, 20 °C – Winterkurve gilt trotzdem', () => {
            const W = fall(20, { sommer: null, winter: 'kalt' });
            assert.strictEqual(W.states['rad1.AktiveKurve'], 'winter', zeig(W));
        });
        it('L: kein gültiger Messwert – Sommerkurve', () => {
            const W = fall(null, { sommer: 'schnell', winter: 'kalt' });
            assert.strictEqual(W.states['rad1.AktiveKurve'], 'sommer', zeig(W));
        });
        it('Vergleich: bei Kälte stoppt die Winterkurve genauer als die Sommerkurve', () => {
            const mitWinter = fall(5, { sommer: 'schnell', winter: 'kalt' });
            const nurSommer = fall(5, { sommer: 'schnell' });
            const abw = W => Math.abs(W.akku.rad1 - 80);
            assert.ok(abw(mitWinter) <= abw(nurSommer), `Winter ${mitWinter.akku.rad1.toFixed(1)} % / Sommer ${nurSommer.akku.rad1.toFixed(1)} %`);
        });
        it('M: Aufzeichnung als Winterkurve – Sommerkurve bleibt, Angaben mit Temperatur', () => {
            const W = lauf({ start: t(19, 17, 0), bis: t(20, 0, 0), temp: 4,
                raeder: [{ id: 'rad1', lader: 'kalt', sommer: 'schnell', akku: 10, ziel: 80, modus: 'aufzeichnen', aufzArt: 'winter' }],
                aktion: [[t(19, 17, 0), start('rad1')]] });
            const so = JSON.parse(W.states['rad1.Kurve']), wi = JSON.parse(W.states['rad1.KurveWinter']);
            assert.ok(wi.length > 100, zeig(W));
            assert.ok(Math.max(...wi.map(e => e.p)) < 170, 'Winterkurve sollte die kalte Leistung zeigen');
            assert.ok(Math.max(...so.map(e => e.p)) > 180, 'Sommerkurve darf nicht überschrieben werden');
            const info = JSON.parse(W.states['rad1.KurvenInfo']);
            assert.strictEqual(info.winter.temp, 4); assert.strictEqual(info.winter.start, 10);
            assert.strictEqual(W.states['rad1.Modus'], 'laden');
        });
    });

    after(() => { void hm; });
});
