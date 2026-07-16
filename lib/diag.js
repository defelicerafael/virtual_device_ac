'use strict';

// ============ DIAGNÓSTICO TEMPORAL (quitar tras resolver el crash en modo
// instalado): reporta hitos y errores a un listener en la Pi de San Fran.

function reportDiag(tag, err) {
  try {
    const body = `[${tag}] ${(err && (err.stack || err.message)) || String(err)}`;
    const req = require('http').request({
      host: '192.168.88.101', port: 9999, method: 'POST', path: '/',
      headers: { 'Content-Length': Buffer.byteLength(body) },
    });
    req.on('error', () => {});
    req.end(body);
  } catch (_) { /* nunca romper por el diagnóstico */ }
}

module.exports = reportDiag;
