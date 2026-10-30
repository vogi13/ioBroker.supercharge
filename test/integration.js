'use strict';
const path = require('path');
const assert = require('assert');
const { tests } = require('@iobroker/testing');

const KURVE = JSON.stringify(Array.from({ length: 30 }, (_, i) => ({ p: 150 - i, soc: 10 + i * 3 })));
const warte = ms => new Promise(r => setTimeout(r, ms));

tests.integration(path.join(__dirname, '..'), {
    allowedExitCodes: [11],
    defineAdditionalTests({ suite }) {
        suite('Supercharge mit zwei Rädern', getHarness => {
            let harness;
            before(async function () {
                this.timeout(60000);
                harness = getHarness();
                const st = (id, type, val) => harness.objects.setObjectAsync
                    ? harness.objects.setObjectAsync(id, { type: 'state', common: { name: id, type, role: 'state', read: true, write: true }, native: {} })
                        .then(() => harness.states.setStateAsync(id, { val, ack: true }))
                    : null;
                await st('0_userdata.0.plug1.Switch', 'boolean', false);
                await st('0_userdata.0.plug1.Power', 'number', 0);
                await st('0_userdata.0.plug2.Switch', 'boolean', false);
                await st('0_userdata.0.plug2.Power', 'number', 0);
                await st('0_userdata.0.alt.Jutta.Kurve', 'string', KURVE);
                await st('0_userdata.0.garage.temp', 'number', 7.5);
                await st('0_userdata.0.alt.Jutta.StartSOCAufz', 'number', 12);
                await st('0_userdata.0.alt.Statistik', 'string', JSON.stringify([{ rad: 'Jutta', datum: '2026-10-20 18:00', modus: 'laden', startSOC: 30, endSOC: 80, minuten: 90, wh: 200, grund: 'Ziel 80 % erreicht' }]));
                await harness.changeAdapterConfig('supercharge', {
                    native: {
                        raeder: [
                            { slot: '1', name: 'Jutta', farbe: 'blau', schalter: '0_userdata.0.plug1.Switch', leistung: '0_userdata.0.plug1.Power' },
                            { slot: '3', name: 'Werner', farbe: 'orange', schalter: '0_userdata.0.plug2.Switch', leistung: '0_userdata.0.plug2.Power' },
                        ],
                        backupAktiv: true, backupStart: '03:15', backupDauer: 20, webAktiv: true, port: 18095, tempDp: '0_userdata.0.garage.temp', tempSchwelle: 10,
                    },
                });
                await harness.startAdapterAndWait();
                await warte(3000);
            });

            it('meldet sich bereit und legt die Datenpunkte an', async () => {
                const con = await harness.states.getStateAsync('supercharge.0.info.connection');
                assert.strictEqual(con && con.val, true);
                const obj = await harness.objects.getObjectAsync('supercharge.0.rad3.SOC');
                assert.ok(obj, 'rad3.SOC fehlt');
                const kanal = await harness.objects.getObjectAsync('supercharge.0.rad1');
                assert.strictEqual(kanal.common.name, 'Jutta');
            });

            it('veröffentlicht die Konfiguration für die App', async () => {
                const k = JSON.parse((await harness.states.getStateAsync('supercharge.0.info.konfig')).val);
                assert.deepStrictEqual(k.raeder.map(r => r.id), ['rad1', 'rad3']);
                assert.strictEqual(k.backup.aktiv, true);
                assert.strictEqual(k.backup.start, '03:15');
                assert.strictEqual(k.backup.dauer, 20);
            });

            it('übernimmt die Temperatur vom Sensor', async () => {
                assert.strictEqual((await harness.states.getStateAsync('supercharge.0.Temperatur')).val, 7.5);
                const k = JSON.parse((await harness.states.getStateAsync('supercharge.0.info.konfig')).val);
                assert.deepStrictEqual(k.temp, { aktiv: true, schwelle: 10 });
                await harness.states.setStateAsync('0_userdata.0.garage.temp', { val: 14.26, ack: true });
                await warte(800);
                assert.strictEqual((await harness.states.getStateAsync('supercharge.0.Temperatur')).val, 14.3);
                assert.ok(await harness.objects.getObjectAsync('supercharge.0.rad1.KurveWinter'));
            });

            it('bestätigt Schreibzugriffe der App (ack)', async () => {
                await harness.states.setStateAsync('supercharge.0.rad1.ZielSOC', { val: '60', ack: false });
                await warte(1000);
                const st = await harness.states.getStateAsync('supercharge.0.rad1.ZielSOC');
                assert.strictEqual(st.val, 60); assert.strictEqual(st.ack, true);
            });

            it('übernimmt Ladekurven und Statistik aus dem Skript', async function () {
                this.timeout(15000);
                const antwort = await new Promise(resolve => harness.sendTo('supercharge.0', 'importKurven', { prefix: '0_userdata.0.alt' }, resolve));
                assert.ok(antwort && /Jutta/.test(antwort.result), JSON.stringify(antwort));
                assert.ok(/Werner/.test(antwort.result), 'Werner sollte als nicht gefunden gemeldet werden');
                await warte(1000);
                assert.strictEqual((await harness.states.getStateAsync('supercharge.0.rad1.Kurve')).val, KURVE);
                assert.strictEqual((await harness.states.getStateAsync('supercharge.0.rad1.StartSOCAufz')).val, 12);
                const stat = JSON.parse((await harness.states.getStateAsync('supercharge.0.Statistik')).val);
                assert.strictEqual(stat[0].rad, 'rad1'); assert.strictEqual(stat[0].name, 'Jutta');
            });

            it('Start schaltet die Steckdose ein, Abbruch wieder aus', async function () {
                this.timeout(15000);
                await harness.states.setStateAsync('supercharge.0.rad1.Start', { val: true, ack: false });
                await warte(1500);
                assert.strictEqual((await harness.states.getStateAsync('0_userdata.0.plug1.Switch')).val, true);
                assert.strictEqual((await harness.states.getStateAsync('supercharge.0.rad1.Laeuft')).val, true);
                assert.strictEqual((await harness.states.getStateAsync('supercharge.0.rad1.Start')).val, false);
                await harness.states.setStateAsync('supercharge.0.rad1.Abbruch', { val: true, ack: false });
                await warte(1500);
                assert.strictEqual((await harness.states.getStateAsync('0_userdata.0.plug1.Switch')).val, false);
                assert.strictEqual((await harness.states.getStateAsync('supercharge.0.rad1.Laeuft')).val, false);
            });

            it('eigener Webserver: App, Zustand und Schreiben', async function () {
                this.timeout(15000);
                const html = await (await fetch('http://127.0.0.1:18095/')).text();
                assert.ok(/window\.SUPERCHARGE=\{"quelle":"eigen"/.test(html), 'Verbindungs-Konfiguration fehlt');
                const icon = await fetch('http://127.0.0.1:18095/icon.png');
                assert.strictEqual(icon.status, 200);
                const z = await (await fetch('http://127.0.0.1:18095/api/zustand')).json();
                assert.deepStrictEqual(JSON.parse(z.konfig).raeder.map(r => r.name), ['Jutta', 'Werner']);
                assert.ok('rad3.SOC' in z.states && !('rad1.Sitzung' in z.states));
                assert.strictEqual(z.states.Temperatur, 14.3);
                assert.ok('rad1.KurveWinter' in z.states && 'rad1.AufzArt' in z.states);
                const r = await fetch('http://127.0.0.1:18095/api/set', { method: 'POST', body: JSON.stringify({ key: 'rad3.ZielSOC', value: 100 }) });
                assert.strictEqual(r.status, 200);
                await warte(800);
                assert.strictEqual((await harness.states.getStateAsync('supercharge.0.rad3.ZielSOC')).val, 100);
                const verboten = await fetch('http://127.0.0.1:18095/api/set', { method: 'POST', body: JSON.stringify({ key: 'rad3.SOC', value: 5 }) });
                assert.strictEqual(verboten.status, 403);
                const fremd = await fetch('http://127.0.0.1:18095/api/set', { method: 'POST', body: JSON.stringify({ key: '../system.adapter.admin.0', value: 1 }) });
                assert.strictEqual(fremd.status, 403);
                const pfad = await fetch('http://127.0.0.1:18095/..%2F..%2Fpackage.json');
                assert.strictEqual(pfad.status, 404);
            });

            it('Aufzeichnung über die App-Schnittstelle startet als Aufzeichnung', async function () {
                this.timeout(15000);
                const post = (key, value) => fetch('http://127.0.0.1:18095/api/set', { method: 'POST', body: JSON.stringify({ key, value }) });
                await post('rad1.StartSOCAufz', '15'); await post('rad1.AufzArt', 'winter');
                await post('rad1.Modus', 'aufzeichnen'); await post('rad1.Start', true);
                await warte(1500);
                const z = await (await fetch('http://127.0.0.1:18095/api/zustand')).json();
                console.log('ZUSTAND', z.states['rad1.Modus'], z.states['rad1.Laeuft'], z.states['rad1.Status'], z.states['rad1.AktiveKurve']);
                assert.strictEqual(z.states['rad1.Modus'], 'aufzeichnen');
                assert.ok(/aufzeichnen als Winterkurve/.test(z.states['rad1.Status']), z.states['rad1.Status']);
                await post('rad1.Abbruch', true); await warte(1000);
            });

            it('Aufzeichnung über Datenpunkte (simple-api-Weg) startet als Aufzeichnung', async function () {
                this.timeout(15000);
                await harness.states.setStateAsync('supercharge.0.rad1.AufzArt', { val: 'winter', ack: false });
                await harness.states.setStateAsync('supercharge.0.rad1.Modus', { val: 'aufzeichnen', ack: false });
                await harness.states.setStateAsync('supercharge.0.rad1.Start', { val: true, ack: false });
                await warte(1500);
                const st = await harness.states.getStateAsync('supercharge.0.rad1.Status');
                const mo = await harness.states.getStateAsync('supercharge.0.rad1.Modus');
                console.log('DP', mo.val, st.val);
                assert.strictEqual(mo.val, 'aufzeichnen');
                await harness.states.setStateAsync('supercharge.0.rad1.Abbruch', { val: true, ack: false }); await warte(1000);
            });

            it('Shelly meldet nach dem Einschalten kurz noch „aus“ – Aufzeichnung läuft weiter', async function () {
                this.timeout(15000);
                await harness.states.setStateAsync('supercharge.0.rad1.AufzArt', { val: 'winter', ack: false });
                await harness.states.setStateAsync('supercharge.0.rad1.Modus', { val: 'aufzeichnen', ack: false });
                await harness.states.setStateAsync('supercharge.0.rad1.Start', { val: true, ack: false });
                await warte(800);
                // Gerät bestätigt erst den alten Zustand, dann den neuen
                await harness.states.setStateAsync('0_userdata.0.plug1.Switch', { val: false, ack: true });
                await warte(300);
                await harness.states.setStateAsync('0_userdata.0.plug1.Switch', { val: true, ack: true });
                await warte(1200);
                const st = (await harness.states.getStateAsync('supercharge.0.rad1.Status')).val;
                const mo = (await harness.states.getStateAsync('supercharge.0.rad1.Modus')).val;
                console.log('NACH ECHO', mo, st);
                assert.strictEqual(mo, 'aufzeichnen', st);
                assert.ok(/aufzeichnen als Winterkurve/.test(st), st);
                await harness.states.setStateAsync('supercharge.0.rad1.Abbruch', { val: true, ack: false }); await warte(1000);
            });

            it('Shelly meldet nach dem Ausschalten kurz noch „ein“ – Stoppen bleibt gestoppt', async function () {
                this.timeout(15000);
                await harness.states.setStateAsync('supercharge.0.rad1.Modus', { val: 'laden', ack: false });
                await harness.states.setStateAsync('supercharge.0.rad1.Start', { val: true, ack: false });
                await warte(800);
                await harness.states.setStateAsync('0_userdata.0.plug1.Switch', { val: true, ack: true });
                await warte(300);
                await harness.states.setStateAsync('supercharge.0.rad1.Abbruch', { val: true, ack: false });
                await warte(500);
                await harness.states.setStateAsync('0_userdata.0.plug1.Switch', { val: true, ack: true });   // alter Zustand
                await warte(300);
                await harness.states.setStateAsync('0_userdata.0.plug1.Switch', { val: false, ack: true });
                await warte(1200);
                assert.strictEqual((await harness.states.getStateAsync('supercharge.0.rad1.Laeuft')).val, false);
                assert.ok(/manuell abgebrochen/.test((await harness.states.getStateAsync('supercharge.0.rad1.Status')).val));
                const stat = JSON.parse((await harness.states.getStateAsync('supercharge.0.Statistik')).val);
                assert.ok(stat.every(e => e.minuten > 0), 'Vorgänge ohne Minute dürfen nicht in die Statistik');
            });

            it('Rad ohne Ladekurve startet nicht', async () => {
                await harness.states.setStateAsync('supercharge.0.rad3.Start', { val: true, ack: false });
                await warte(1500);
                assert.strictEqual((await harness.states.getStateAsync('0_userdata.0.plug2.Switch')).val, false);
                assert.ok(/keine Ladekurve/.test((await harness.states.getStateAsync('supercharge.0.rad3.Status')).val));
            });
        });
    },
});
