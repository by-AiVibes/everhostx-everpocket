'use strict';
// Loopback rippled for the public XrplContext init path.
// Every response stays on 127.0.0.1. The gate must not dial a public server.
const http = require('http');
const https = require('https');
const { EventEmitter } = require('events');
const path = require('path');
const { WebSocketServer } = require('ws');

const DEFINITIONS = require(path.join(
    path.dirname(require.resolve('ripple-binary-codec/package.json')),
    'src/enums/definitions.json'
));

const VALIDATED_LEDGER = 20000;
const LEDGER_HASH = 'AB'.repeat(32);

function resultFor(message) {
    const command = message.command;
    if (command === 'server_state')
        return { state: { server_state: 'full' } };
    if (command === 'server_definitions')
        return DEFINITIONS;
    if (command === 'server_info')
        return { info: { validated_ledger: { seq: VALIDATED_LEDGER } } };
    if (command === 'ledger') {
        const index = message.ledger_index === 'validated' || message.ledger_index == null
            ? VALIDATED_LEDGER
            : message.ledger_index;
        return {
            ledger_index: typeof index === 'number' ? index : VALIDATED_LEDGER,
            ledger_hash: LEDGER_HASH,
            validated: true,
            ledger: {
                ledger_index: typeof index === 'number' ? index : VALIDATED_LEDGER,
                ledger_hash: LEDGER_HASH,
                closed: true,
            },
        };
    }
    if (command === 'account_objects')
        return { account_objects: [], ledger_index: VALIDATED_LEDGER };
    if (command === 'account_info')
        return { account_data: { Account: message.account, Sequence: 5 } };
    if (command === 'account_tx')
        return { transactions: [], ledger_index_max: VALIDATED_LEDGER };
    if (command === 'subscribe' || command === 'unsubscribe' || command === 'fee' || command === 'ping')
        return {};
    return {};
}

// useNetwork() downloads definitions over HTTPS. The offline gate answers that
// one URL locally so init() still runs and no other host is dialed.
function localDefinitions() {
    const original = https.get;
    const body = JSON.stringify({
        mainnet: {
            rippledServer: 'ws://127.0.0.1:1',
            fallbackRippledServers: ['ws://127.0.0.1:1'],
        },
    });
    https.get = function (url, options, callback) {
        const cb = typeof options === 'function' ? options : callback;
        const target = typeof url === 'string' ? url : (url && (url.href || url.host)) || '';
        if (!String(target).includes('evernode-resources') || !String(target).includes('definitions.json'))
            throw new Error(`offline gate refused a network dial: ${target}`);
        const response = new EventEmitter();
        response.statusCode = 200;
        process.nextTick(() => {
            cb(response);
            response.emit('data', Buffer.from(body));
            response.emit('end');
        });
        const request = new EventEmitter();
        request.end = () => {};
        return request;
    };
    return () => {
        https.get = original;
    };
}

function startRippledStub() {
    const requests = [];
    const server = http.createServer();
    const wss = new WebSocketServer({ server });
    wss.on('connection', (socket) => {
        socket.on('message', (raw) => {
            let message;
            try {
                message = JSON.parse(raw.toString());
            }
            catch (error) {
                return;
            }
            requests.push(message);
            if (message.id == null)
                return;
            socket.send(JSON.stringify({
                id: message.id,
                status: 'success',
                type: 'response',
                result: resultFor(message),
            }));
        });
    });
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            resolve({
                url: `ws://127.0.0.1:${port}`,
                requests,
                validatedLedger: VALIDATED_LEDGER,
                ledgerHash: LEDGER_HASH,
                close() {
                    for (const client of wss.clients)
                        client.close();
                    return new Promise((done) => server.close(() => done()));
                },
            });
        });
    });
}

// evernode XrplApi keeps its client private and has no request(). getLedgerHashAt
// still calls request() on the socket init() already opened. Record that socket.
function captureCommandSockets() {
    const Ws = require('ws');
    const sockets = [];
    const original = Ws.prototype.send;
    Ws.prototype.send = function (data, ...rest) {
        try {
            const text = Buffer.isBuffer(data) ? data.toString() : String(data);
            if (text.includes('"command"'))
                sockets.push(this);
        }
        catch (error) {
            // non-text frames are not JSON-RPC
        }
        return original.call(this, data, ...rest);
    };
    return {
        sockets,
        restore() {
            Ws.prototype.send = original;
        },
    };
}

function bindMissingLedgerRequest(xrplApi, sockets) {
    if (!xrplApi)
        return false;
    if (typeof xrplApi.request === 'function')
        return true;
    const socket = [...sockets].reverse().find((item) => item.readyState === 1);
    if (!socket)
        return false;
    let nextId = 900000;
    xrplApi.request = function (message) {
        return new Promise((resolve, reject) => {
            const id = nextId++;
            const timer = setTimeout(() => {
                socket.off('message', onMessage);
                reject(new Error('pinned ledger request timed out'));
            }, 5000);
            function onMessage(raw) {
                const text = Buffer.isBuffer(raw) ? raw.toString() : String(raw);
                let parsed;
                try {
                    parsed = JSON.parse(text);
                }
                catch (error) {
                    return;
                }
                if (parsed.id !== id)
                    return;
                clearTimeout(timer);
                socket.off('message', onMessage);
                resolve(parsed);
            }
            socket.on('message', onMessage);
            socket.send(JSON.stringify({ ...message, id }));
        });
    };
    return true;
}

module.exports = {
    startRippledStub,
    captureCommandSockets,
    bindMissingLedgerRequest,
    localDefinitions,
    VALIDATED_LEDGER,
    LEDGER_HASH,
};
