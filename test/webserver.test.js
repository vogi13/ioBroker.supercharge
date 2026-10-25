'use strict';
const assert = require('assert');
const { webserver } = require('../lib/webserver');

describe('Webserver mit Passwort', () => {
    let srv; const gesetzt = [];
    before(async () => {
        srv = webserver({ bind: '127.0.0.1', port: 18096, passwort: 'geheim äö',
            zustand: () => ({ konfig: '{}', states: { 'rad1.SOC': 50 } }),
            setzen: (k, v) => { gesetzt.push([k, v]); return true; },
            verbindung: () => ({ quelle: 'eigen', passwort: true }),
            log: { info() {}, warn() {}, error() {} } });
        assert.ok(await srv.starten());
    });
    after(() => srv.stoppen());
    it('App ist ohne Passwort abrufbar', async () => {
        const r = await fetch('http://127.0.0.1:18096/');
        assert.strictEqual(r.status, 200);
        assert.ok((await r.text()).includes('"passwort":true'));
    });
    it('Schnittstelle verlangt das Passwort', async () => {
        assert.strictEqual((await fetch('http://127.0.0.1:18096/api/zustand')).status, 401);
        assert.strictEqual((await fetch('http://127.0.0.1:18096/api/zustand', { headers: { Authorization: 'Bearer falsch' } })).status, 401);
        const ok = await fetch('http://127.0.0.1:18096/api/zustand', { headers: { Authorization: `Bearer ${encodeURIComponent('geheim äö')}` } });
        assert.strictEqual(ok.status, 200);
        assert.strictEqual((await ok.json()).states['rad1.SOC'], 50);
    });
    it('Schreiben mit Passwort', async () => {
        const r = await fetch('http://127.0.0.1:18096/api/set', { method: 'POST', headers: { Authorization: `Bearer ${encodeURIComponent('geheim äö')}` }, body: JSON.stringify({ key: 'rad1.ZielSOC', value: 60 }) });
        assert.strictEqual(r.status, 200);
        assert.deepStrictEqual(gesetzt.pop(), ['rad1.ZielSOC', 60]);
    });
    it('belegter Port wird gemeldet statt abzustürzen', async () => {
        let fehler = '';
        const zweiter = webserver({ bind: '127.0.0.1', port: 18096, zustand() {}, setzen() {}, verbindung: () => ({}), log: { info() {}, warn() {}, error: t => { fehler = t; } } });
        assert.strictEqual(await zweiter.starten(), false);
        assert.ok(/belegt/.test(fehler));
    });
});
