'use strict';
/**
 * ioBroker-Adapter „supercharge“ – akkuschonendes Laden von 1 bis 4 E-Bikes
 * über schaltbare Steckdosen mit Leistungsmessung (z. B. Shelly Plug S / 1PM / 2PM).
 */
const utils = require('@iobroker/adapter-core');
const { Rad, DP_RAD, BUTTONS } = require('./lib/rad');
const { planung } = require('./lib/planung');
const { webserver } = require('./lib/webserver');

const MAX_RAEDER = 4;
const SCHALT_SPERRE_MS = 20000;   // so lange nach eigenem Schalten abweichende Rückmeldungen ignorieren
const FARBEN = ['blau', 'orange', 'gruen', 'lila'];
const WOCHENTAGE = ['backupSo', 'backupMo', 'backupDi', 'backupMi', 'backupDo', 'backupFr', 'backupSa']; // Index = Date.getDay()

const DP_GEMEINSAM = {
    Statistik: { def: '[]', type: 'string', role: 'json', name: 'Ladestatistik aller Räder (JSON)', write: false },
    Temperatur: { def: null, type: 'number', unit: '°C', role: 'value.temperature', name: 'Temperatur vom eingestellten Sensor (leer = kein gültiger Wert)', write: false },
};

class Supercharge extends utils.Adapter {
    constructor(options = {}) {
        super({ ...options, name: 'supercharge' });
        this.cache = new Map();      // eigene Datenpunkte: relative ID -> Wert
        this.fremd = new Map();      // fremde Datenpunkte: ID -> Wert
        this.typen = new Map();      // relative ID -> common.type
        this.raeder = [];
        this.zuordnung = new Map();  // fremde ID -> [{ rad, art }]
        this.offen = new Set();      // laufende Schreibvorgänge (für sauberes Beenden)
        this.server = null;
        this.verbindungInfo = {};
        this.befehle = new Map();    // zuletzt selbst geschaltet: Steckdose -> { val, ts }
        this.temp = { id: '', val: null, ts: 0, maxAlterMs: 3 * 3600e3 };
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    // ---------------- Konfiguration ----------------
    raederAusKonfig() {
        const liste = Array.isArray(this.config.raeder) ? this.config.raeder : [];
        const belegt = new Set(), out = [];
        for (const z of liste) {
            const slot = parseInt(z.slot, 10);
            const name = String(z.name || '').trim();
            if (!(slot >= 1 && slot <= MAX_RAEDER)) { this.log.warn(`Rad "${name}": ungültige Nummer ${z.slot} – übersprungen`); continue; }
            if (belegt.has(slot)) { this.log.warn(`Rad-Nummer ${slot} ist doppelt vergeben – "${name}" übersprungen`); continue; }
            if (!name || !z.schalter || !z.leistung) { this.log.warn(`Rad ${slot}: Name, Schalter und Leistung müssen ausgefüllt sein – übersprungen`); continue; }
            belegt.add(slot);
            out.push({ id: `rad${slot}`, slot, name, farbe: FARBEN.includes(z.farbe) ? z.farbe : FARBEN[slot - 1],
                schalter: String(z.schalter).trim(), leistung: String(z.leistung).trim() });
        }
        return out.sort((a, b) => a.slot - b.slot);
    }
    zahl(v, def, min, max) { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def; }
    optionen() {
        const c = this.config;
        const backup = {
            aktiv: !!c.backupAktiv,
            start: /^\d{1,2}:\d{2}/.test(String(c.backupStart || '')) ? String(c.backupStart).slice(0, 5) : '04:30',
            dauer: this.zahl(c.backupDauer, 10, 0, 240),
            vorher: this.zahl(c.backupVorher, 5, 0, 120),
            nachher: this.zahl(c.backupNachher, 10, 0, 120),
            tage: WOCHENTAGE.map(k => c[k] !== false),
        };
        return {
            minLeistung: this.zahl(c.minLeistung, 3, 0, 50),
            maxLadezeitMin: Math.round(this.zahl(c.maxLadezeitH, 12, 1, 24) * 60),
            sitzungMaxMin: this.zahl(c.sitzungMaxMin, 60, 5, 1440),
            parkSoc: this.zahl(c.parkSoc, 80, 50, 95),
            pufferMin: this.zahl(c.pufferMin, 20, 0, 180),
            minPauseMin: this.zahl(c.minPauseMin, 15, 0, 180),
            ziele: { lagerung: this.zahl(c.zielLagerung, 60, 20, 95), alltag: this.zahl(c.zielAlltag, 80, 20, 99) },
            backup,
            plan: planung(backup),
            tempSchwelle: this.zahl(c.tempSchwelle, 12, -20, 40),
            temperatur: () => this.temperatur(),
        };
    }

    // ---------------- Objekte ----------------
    async datenpunkt(rel, d) {
        const common = { name: d.name, type: d.type, role: d.role || 'state', read: true, write: d.write !== false, def: d.def };
        if (d.unit) common.unit = d.unit;
        if (d.min !== undefined) common.min = d.min;
        if (d.max !== undefined) common.max = d.max;
        if (d.states) common.states = d.states;
        await this.setObjectNotExistsAsync(rel, { type: 'state', common, native: {} });
        this.typen.set(rel, d.type);
    }
    async objekteAnlegen(raeder) {
        await this.setObjectNotExistsAsync('info', { type: 'channel', common: { name: 'Information' }, native: {} });
        await this.setObjectNotExistsAsync('info.connection', { type: 'state', common: { name: 'Adapter bereit', type: 'boolean', role: 'indicator.connected', read: true, write: false, def: false }, native: {} });
        await this.datenpunkt('info.konfig', { def: '{}', type: 'string', role: 'json', name: 'Konfiguration für die App (Räder, Farben, Ziele, Backup)', write: false });
        for (const [k, d] of Object.entries(DP_GEMEINSAM)) await this.datenpunkt(k, d);
        for (const r of raeder) {
            await this.setObjectNotExistsAsync(r.id, { type: 'channel', common: { name: r.name }, native: {} });
            await this.extendObjectAsync(r.id, { common: { name: r.name } });
            for (const [k, d] of Object.entries(DP_RAD)) await this.datenpunkt(`${r.id}.${k}`, d);
        }
    }
    async cacheLaden(raeder) {
        const states = await this.getStatesAsync('*') || {};
        const ns = `${this.namespace}.`;
        for (const [fid, st] of Object.entries(states)) if (st) this.cache.set(fid.slice(ns.length), st.val);
        // Vorgabewerte für neue Datenpunkte
        const vorgaben = { ...Object.fromEntries(Object.entries(DP_GEMEINSAM).map(([k, d]) => [k, d.def])) };
        for (const r of raeder) for (const [k, d] of Object.entries(DP_RAD)) vorgaben[`${r.id}.${k}`] = d.def;
        for (const [rel, def] of Object.entries(vorgaben)) {
            if (this.cache.get(rel) === undefined || this.cache.get(rel) === null) this.set(rel, def);
        }
        for (const r of raeder) {
            for (const fid of [r.schalter, r.leistung]) {
                try {
                    const st = await this.getForeignStateAsync(fid);
                    this.fremd.set(fid, st ? st.val : null);
                    if (!st) this.log.warn(`${r.name}: Datenpunkt ${fid} hat noch keinen Wert – Gerät erreichbar?`);
                } catch (e) { this.log.warn(`${r.name}: Datenpunkt ${fid} nicht lesbar: ${e.message}`); }
            }
        }
    }

    // ---------------- Schnittstelle für die Ladelogik ----------------
    merken(p) { this.offen.add(p); p.catch(e => this.log.warn(`Schreiben fehlgeschlagen: ${e.message}`)).finally(() => this.offen.delete(p)); }
    set(rel, val) {
        this.cache.set(rel, val);
        this.merken(this.setStateAsync(rel, { val, ack: true }));
    }
    env() {
        return {
            get: rel => this.cache.get(rel),
            set: (rel, v) => this.set(rel, v),
            getF: fid => this.fremd.get(fid),
            setF: (fid, v) => {
                this.fremd.set(fid, v);
                this.befehle.set(fid, { val: !!v, ts: Date.now() });
                this.merken(this.setForeignStateAsync(fid, v, false));
            },
            log: { info: t => this.log.info(t), warn: t => this.log.warn(t) },
            setInterval: (f, ms) => this.setInterval(f, ms),
            clearInterval: h => this.clearInterval(h),
            setTimeout: (f, ms) => this.setTimeout(f, ms),
            clearTimeout: h => this.clearTimeout(h),
        };
    }

    // ---------------- Start ----------------
    async onReady() {
        const raeder = this.raederAusKonfig();
        this.temp.id = String(this.config.tempDp || '').trim();
        this.temp.maxAlterMs = this.zahl(this.config.tempMaxAlterH, 3, 0.25, 48) * 3600e3;
        const opt = this.optionen();
        await this.objekteAnlegen(raeder);
        await this.setStateAsync('info.connection', false, true);
        await this.cacheLaden(raeder);
        if (this.temp.id) {
            try {
                const st = await this.getForeignStateAsync(this.temp.id);
                if (st) { this.temp.val = st.val; this.temp.ts = st.ts || Date.now(); }
                else this.log.warn(`Temperatur: Datenpunkt ${this.temp.id} hat noch keinen Wert`);
            } catch (e) { this.log.warn(`Temperatur: ${this.temp.id} nicht lesbar: ${e.message}`); }
            await this.subscribeForeignStatesAsync(this.temp.id);
            this.setInterval(() => this.temperaturVeroeffentlichen(), 10 * 60000);
        }
        this.temperaturVeroeffentlichen();

        this.set('info.konfig', JSON.stringify({
            version: this.version || '',
            raeder: raeder.map(r => ({ id: r.id, name: r.name, farbe: r.farbe })),
            ziele: opt.ziele, park: opt.parkSoc, puffer: opt.pufferMin, minPause: opt.minPauseMin,
            backup: opt.backup,
            temp: { aktiv: !!this.temp.id, schwelle: opt.tempSchwelle },
        }));

        await this.appVerbindung();

        if (!raeder.length) {
            this.log.warn('Noch kein Rad eingerichtet – bitte in den Instanz-Einstellungen Räder eintragen.');
            return;
        }

        const env = this.env();
        for (const cfg of raeder) {
            const rad = Rad(env, cfg, opt);
            this.raeder.push(rad);
            for (const [fid, art] of [[cfg.schalter, 'schalter'], [cfg.leistung, 'leistung']]) {
                if (!this.zuordnung.has(fid)) this.zuordnung.set(fid, []);
                this.zuordnung.get(fid).push({ rad, art });
            }
        }
        this.subscribeStates('*');
        for (const fid of this.zuordnung.keys()) await this.subscribeForeignStatesAsync(fid);
        for (const rad of this.raeder) {
            rad.leistungGeaendert(this.fremd.get(rad.cfg.leistung));
            rad.init();
        }
        await this.setStateAsync('info.connection', true, true);
        this.log.info(`Supercharge bereit: ${raeder.map(r => r.name).join(', ')}${opt.backup.aktiv ? ` · Backup ${opt.backup.start} (${opt.backup.dauer} min) wird ausgespart` : ''}`);
    }

    // ---------------- Temperatur ----------------
    /** gültige Temperatur (gerundet auf 0,1 °C) oder null */
    temperatur() {
        if (!this.temp.id) return null;
        const v = typeof this.temp.val === 'string' ? parseFloat(this.temp.val.replace(',', '.')) : Number(this.temp.val);
        if (this.temp.val === null || this.temp.val === undefined || !Number.isFinite(v)) return null;
        if (Date.now() - this.temp.ts > this.temp.maxAlterMs) return null;
        return Math.round(v * 10) / 10;
    }
    temperaturVeroeffentlichen() {
        const t = this.temperatur();
        if (this.cache.get('Temperatur') !== t) this.set('Temperatur', t);
    }

    // ---------------- App: eigener Webserver / simple-api ----------------
    async appVerbindung() {
        const c = this.config;
        const quelle = c.appQuelle === 'simpleapi' ? 'simpleapi' : 'eigen';
        const info = { quelle, prefix: this.namespace, passwort: !!c.webPasswort, simpleApi: null };
        if (quelle === 'simpleapi') {
            const sa = { url: String(c.simpleApiUrl || '').trim().replace(/\/+$/, ''),
                port: 8087, secure: false, bind: '' };
            const inst = String(c.simpleApiInstanz || 'simple-api.0').replace(/^system\.adapter\./, '');
            try {
                const obj = await this.getForeignObjectAsync(`system.adapter.${inst}`);
                if (obj && obj.native) {
                    sa.port = Number(obj.native.port) || 8087; sa.secure = !!obj.native.secure;
                    sa.bind = obj.native.bind && obj.native.bind !== '0.0.0.0' && obj.native.bind !== '::' ? obj.native.bind : '';
                    if (obj.common && obj.common.enabled === false) this.log.warn(`App: ${inst} ist deaktiviert – die App bekommt so keine Daten`);
                } else if (!sa.url) this.log.warn(`App: Instanz ${inst} nicht gefunden – bitte im Reiter App prüfen`);
            } catch (e) { this.log.warn(`App: ${inst} nicht lesbar: ${e.message}`); }
            info.simpleApi = sa;
        }
        this.verbindungInfo = info;

        if (c.webAktiv === false) {
            this.log.info('Eigener Webserver ist ausgeschaltet – App über den web-Adapter aufrufen (…:8082/supercharge/index.html), Daten über simple-api');
            return;
        }
        this.server = webserver({
            bind: c.bind || '0.0.0.0',
            port: this.zahl(c.port, 8095, 1, 65535),
            passwort: c.webPasswort || '',
            zustand: () => this.appZustand(),
            setzen: (key, value) => this.appSetzen(key, value),
            verbindung: () => this.verbindungInfo,
            log: { info: t => this.log.info(t), warn: t => this.log.warn(t), error: t => this.log.error(t) },
        });
        await this.server.starten();
    }
    appZustand() {
        const states = { Statistik: this.cache.get('Statistik') ?? '[]', Temperatur: this.cache.get('Temperatur') ?? null };
        for (const rad of this.raeder) {
            for (const k of Object.keys(DP_RAD)) if (k !== 'Sitzung') states[`${rad.id}.${k}`] = this.cache.get(`${rad.id}.${k}`) ?? null;
        }
        return { konfig: this.cache.get('info.konfig') || '{}', states };
    }
    appSetzen(key, value) {
        const [radId, k] = key.split('.');
        if (!this.raeder.some(r => r.id === radId) || !DP_RAD[k]) return 'Unbekannter Datenpunkt';
        if (DP_RAD[k].write === false) return 'Nur lesbar';
        this.befehl(key, value);
        return true;
    }

    // ---------------- Ereignisse ----------------
    onStateChange(fid, state) {
        if (!state) return;
        const ns = `${this.namespace}.`;
        if (fid.startsWith(ns)) {
            const rel = fid.slice(ns.length);
            if (state.ack) { this.cache.set(rel, state.val); return; }
            this.befehl(rel, state.val);
            return;
        }
        if (this.temp.id && fid === this.temp.id) {
            this.temp.val = state.val; this.temp.ts = state.ts || Date.now();
            this.temperaturVeroeffentlichen();
            return;
        }
        const ziele = this.zuordnung.get(fid);
        if (!ziele) return;
        const vorher = this.fremd.get(fid);
        // Kurz nach eigenem Schalten melden manche Geräte (z. B. Shelly Gen2/Gen3) erst noch den alten Zustand –
        // solche Zwischenstände ignorieren, sonst würde ein Start als „an der Steckdose ausgeschaltet“ gewertet.
        const cmd = this.befehle.get(fid);
        const istAn = state.val === true || state.val === 'true' || state.val === 1;
        if (cmd && ziele.some(z => z.art === 'schalter') && Date.now() - cmd.ts < SCHALT_SPERRE_MS && istAn !== cmd.val) {
            this.log.debug(`${fid}: Zwischenstand ${state.val} kurz nach eigenem Schalten ignoriert`);
            return;
        }
        this.fremd.set(fid, state.val);
        for (const { rad, art } of ziele) {
            if (art === 'leistung') rad.leistungGeaendert(state.val);
            else if (state.ack && vorher !== state.val) rad.schalterGeaendert(istAn);
        }
    }
    /** Schreibzugriff ohne ack (App, Skripte, Admin) */
    befehl(rel, v) {
        const [radId, key] = rel.split('.');
        const rad = this.raeder.find(r => r.id === radId);
        if (rad && BUTTONS.includes(key)) {
            this.set(rel, false);
            if (v === true || v === 'true' || v === 1 || v === '1') rad.befehl(key);
            return;
        }
        const typ = this.typen.get(rel);
        if (!typ) return;
        const d = rad && DP_RAD[key];
        if (d && d.write === false) { this.set(rel, this.cache.get(rel)); return; }   // nur lesbar: alten Wert behalten
        let wert = v;
        if (typ === 'number') { wert = Number(v); if (!Number.isFinite(wert)) return; if (d && d.min !== undefined) wert = Math.max(d.min, wert); if (d && d.max !== undefined) wert = Math.min(d.max, wert); }
        else if (typ === 'boolean') wert = v === true || v === 'true' || v === 1 || v === '1';
        else wert = v === null || v === undefined ? '' : String(v);
        this.set(rel, wert);
    }

    /** Nachrichten aus der Admin-Seite (Knopf „Ladekurven aus Skript übernehmen“) */
    async onMessage(obj) {
        if (!obj || obj.command !== 'importKurven') return;
        const antwort = r => obj.callback && this.sendTo(obj.from, obj.command, r, obj.callback);
        try {
            const prefix = String((obj.message && obj.message.prefix) || '').trim().replace(/\.$/, '');
            if (!prefix) return antwort({ error: 'Bitte den Datenpunkt-Ordner des Skripts eintragen.' });
            if (!this.raeder.length) return antwort({ error: 'Zuerst Räder einrichten und speichern.' });
            const ok = [], fehlt = [];
            for (const rad of this.raeder) {
                let quelle = null;
                for (const fid of [`${prefix}.${rad.name}.Kurve`, `${prefix}.Kurve`]) {
                    const st = await this.getForeignStateAsync(fid).catch(() => null);
                    let k = null; try { k = JSON.parse(st && st.val); } catch (e) { /* ungültig */ }
                    if (Array.isArray(k) && k.length >= 10) { quelle = { fid, text: st.val }; break; }
                }
                if (!quelle) { fehlt.push(rad.name); continue; }
                this.set(`${rad.id}.Kurve`, quelle.text);
                const sa = await this.getForeignStateAsync(quelle.fid.replace(/Kurve$/, 'StartSOCAufz')).catch(() => null);
                if (sa && Number.isFinite(Number(sa.val))) this.set(`${rad.id}.StartSOCAufz`, Number(sa.val));
                ok.push(`${rad.name} (aus ${quelle.fid})`);
            }
            // Statistik übernehmen, wenn hier noch leer
            const stAlt = await this.getForeignStateAsync(`${prefix}.Statistik`).catch(() => null);
            let statistikTxt = '';
            if (stAlt && stAlt.val && (this.cache.get('Statistik') || '[]') === '[]') {
                let alt = []; try { alt = JSON.parse(stAlt.val) || []; } catch (e) { /* leer */ }
                const map = Object.fromEntries(this.raeder.map(r => [r.name, r.id]));
                const neu = alt.map(e => ({ ...e, name: e.rad, rad: map[e.rad] || e.rad }));
                if (neu.length) { this.set('Statistik', JSON.stringify(neu.slice(0, 100))); statistikTxt = ` Statistik: ${neu.length} Einträge übernommen.`; }
            }
            this.log.info(`Ladekurven übernommen: ${ok.join(', ') || 'keine'}${fehlt.length ? ` · nicht gefunden: ${fehlt.join(', ')}` : ''}`);
            antwort({ result: `Übernommen: ${ok.length ? ok.map(t => t.split(' (')[0]).join(', ') : 'keine'}${fehlt.length ? ` · nicht gefunden: ${fehlt.join(', ')}` : ''}.${statistikTxt}` });
        } catch (e) {
            antwort({ error: e.message });
        }
    }

    async onUnload(callback) {
        try {
            for (const rad of this.raeder) rad.stopp();
            if (this.server) await this.server.stoppen();
            await Promise.race([Promise.allSettled([...this.offen]), new Promise(r => setTimeout(r, 1500))]);
            await this.setStateAsync('info.connection', false, true).catch(() => {});
        } finally {
            callback();
        }
    }
}

if (require.main !== module) {
    module.exports = options => new Supercharge(options);
} else {
    (() => new Supercharge())();
}
