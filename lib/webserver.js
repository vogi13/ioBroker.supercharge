'use strict';
/**
 * Kleiner eigener Webserver: liefert die App (www/) und eine schlanke JSON-Schnittstelle,
 * die nur die Datenpunkte von Supercharge kennt.
 *
 *   GET  /                 App (index.html, mit eingebetteter Verbindungs-Konfiguration)
 *   GET  /icon.png         Symbol
 *   GET  /api/zustand      { konfig, states: { "rad1.SOC": 62, … } }
 *   POST /api/set          { key: "rad1.ZielSOC", value: 80 }
 *
 * Mit Passwort: Kopfzeile "Authorization: Bearer <Passwort>" für /api/*.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const WWW = path.join(__dirname, '..', 'www');
const MIME = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function gleich(a, b) {
    const x = Buffer.from(String(a)), y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * @param {object} p
 *  bind, port, passwort
 *  zustand(): { konfig, states }       aktueller Zustand aus dem Cache
 *  setzen(key, value): true | Fehlertext
 *  verbindung(): Objekt, das als window.SUPERCHARGE in die App eingebettet wird
 *  log: { info, warn, error }
 */
function webserver(p) {
    const senden = (res, code, body, typ = 'application/json; charset=utf-8', extra = {}) => {
        res.writeHead(code, { 'Content-Type': typ, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra });
        res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    };
    const erlaubt = req => {
        if (!p.passwort) return true;
        const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
        return !!m && gleich(decodeURIComponent(m[1]), p.passwort);
    };
    const koerper = req => new Promise((resolve, reject) => {
        let daten = '';
        req.on('data', c => { daten += c; if (daten.length > 1e6) { reject(new Error('zu groß')); req.destroy(); } });
        req.on('end', () => resolve(daten));
        req.on('error', reject);
    });

    const server = http.createServer(async (req, res) => {
        try {
            const url = new URL(req.url, 'http://x');
            const pfad = decodeURIComponent(url.pathname);

            if (pfad.startsWith('/api/')) {
                if (!erlaubt(req)) return senden(res, 401, { fehler: 'Passwort falsch oder fehlt' });
                if (pfad === '/api/zustand' && req.method === 'GET') return senden(res, 200, p.zustand());
                if (pfad === '/api/set' && req.method === 'POST') {
                    let j = null;
                    try { j = JSON.parse(await koerper(req)); } catch (e) { return senden(res, 400, { fehler: 'Ungültige Anfrage' }); }
                    const r = p.setzen(String(j && j.key || ''), j ? j.value : undefined);
                    return r === true ? senden(res, 200, { ok: true }) : senden(res, 403, { fehler: r });
                }
                return senden(res, 404, { fehler: 'Unbekannt' });
            }

            if (req.method !== 'GET' && req.method !== 'HEAD') return senden(res, 405, 'Methode nicht erlaubt', 'text/plain; charset=utf-8');
            const datei = pfad === '/' ? 'index.html' : path.normalize(pfad).replace(/^([/\\])+/, '');
            const voll = path.join(WWW, datei);
            if (!voll.startsWith(WWW + path.sep) || !fs.existsSync(voll) || !fs.statSync(voll).isFile()) return senden(res, 404, 'Nicht gefunden', 'text/plain; charset=utf-8');
            let inhalt = fs.readFileSync(voll);
            if (datei === 'index.html') {
                const json = JSON.stringify(p.verbindung()).replace(/</g, '\\u003c');
                inhalt = inhalt.toString('utf8').replace('<!--SUPERCHARGE-SERVER-->', `<script>window.SUPERCHARGE=${json};</script>`);
            }
            return senden(res, 200, inhalt, MIME[path.extname(voll)] || 'application/octet-stream',
                datei === 'index.html' ? { 'Referrer-Policy': 'no-referrer' } : { 'Cache-Control': 'max-age=3600' });
        } catch (e) {
            p.log.warn(`Webserver: ${e.message}`);
            try { senden(res, 500, { fehler: 'Interner Fehler' }); } catch (e2) { /* Antwort schon gesendet */ }
        }
    });

    return {
        starten: () => new Promise(resolve => {
            server.once('error', e => {
                p.log.error(e.code === 'EADDRINUSE'
                    ? `Webserver: Port ${p.port} ist schon belegt – bitte in den Einstellungen (Reiter App) einen anderen Port wählen`
                    : `Webserver konnte nicht starten: ${e.message}`);
                resolve(false);
            });
            server.listen(p.port, p.bind || '0.0.0.0', () => {
                p.log.info(`App erreichbar unter http://${p.bind && p.bind !== '0.0.0.0' ? p.bind : '<ioBroker-IP>'}:${p.port}/${p.passwort ? ' (mit Passwort)' : ''}`);
                resolve(true);
            });
        }),
        stoppen: () => new Promise(resolve => { server.close(() => resolve()); setTimeout(resolve, 500); }),
    };
}

module.exports = { webserver };
