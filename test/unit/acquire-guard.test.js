'use strict';

const assert = require('node:assert/strict');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const path = require('path');
const { Worker } = require('node:worker_threads');
const { describe, test } = require('node:test');
const evernode = require('evernode-js-client');
const kp = require('ripple-keypairs');

require('../../dist/context/EvernodeContext');

const SECP256K1_ORDER = Buffer.from('fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141', 'hex');
const FAST_LIMIT_MS = 2000;

describe('acquire encrypt entry rejects an invalid ephemeral key', { concurrency: 1 }, () => {
    test('a zero ephemeral key throws a normal error in under 2 seconds', async () => {
        await assertFastInvalidKey(Buffer.alloc(32, 0));
    });

    test('a curve-order ephemeral key throws a normal error in under 2 seconds', async () => {
        await assertFastInvalidKey(Buffer.from(SECP256K1_ORDER));
    });

    test('a library-derived ephemeral key still encrypts', async () => {
        const { publicKey } = hostKey();
        const { derivePrivateKey } = require('ripple-keypairs/dist/secp256k1');
        const key = derivePrivateKey(Buffer.from('everpocket-acquire-guard'), { validator: true }).toArrayLike(Buffer, 'be', 32);
        const started = Date.now();
        const encrypted = await evernode.EncryptionHelper.encrypt(publicKey, { ping: 1 }, {
            iv: crypto.randomBytes(16),
            ephemPrivateKey: key
        });
        assert.equal(typeof encrypted, 'string', 'a valid ephemeral key must encrypt');
        assert.ok(Date.now() - started < FAST_LIMIT_MS, 'a valid ephemeral key must encrypt quickly');
    });
});

describe('Math.random stays banned with inline config disabled', { concurrency: 1 }, () => {
    test('eslint --no-inline-config rejects Math.random in src', () => {
        const eslint = path.join(__dirname, '../../node_modules/.bin/eslint');
        const config = path.join(__dirname, '../../.eslintrc.json');
        const source = spawnSync(eslint, ['-c', config, '--no-inline-config', '--ext', '.ts', path.join(__dirname, '../../src')], {
            encoding: 'utf8'
        });
        assert.equal(source.status, 0, `Math.random must not be used in src, including behind an inline disable\n${source.stdout}\n${source.stderr}`);
    });
});

async function assertFastInvalidKey(key) {
    const { publicKey } = hostKey();
    const started = Date.now();
    await assert.rejects(
        () => encryptOnWorker(publicKey, key),
        (error) => {
            assert.equal(error instanceof Error, true, 'invalid ephemeral key must throw an Error');
            assert.match(error.message, /acquire ephemeral key is not a valid secp256k1 private key/);
            return true;
        }
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed < FAST_LIMIT_MS, `invalid ephemeral key must fail in under ${FAST_LIMIT_MS}ms, took ${elapsed}ms`);
}

function encryptOnWorker(publicKey, key) {
    return new Promise((resolve, reject) => {
        const worker = new Worker(`
            const { parentPort, workerData } = require('node:worker_threads');
            const crypto = require('crypto');
            const evernode = require('evernode-js-client');
            require(workerData.entry);
            evernode.EncryptionHelper.encrypt(workerData.publicKey, { ping: 1 }, {
                iv: crypto.randomBytes(16),
                ephemPrivateKey: Buffer.from(workerData.key)
            }).then((value) => {
                parentPort.postMessage({ ok: true, type: typeof value });
            }, (error) => {
                parentPort.postMessage({ ok: false, message: error && error.message ? error.message : String(error) });
            });
        `, {
            eval: true,
            workerData: {
                entry: path.join(__dirname, '../../dist/context/EvernodeContext.js'),
                publicKey,
                key: Buffer.from(key)
            }
        });
        const timer = setTimeout(() => {
            worker.terminate();
            reject(new Error('encrypt entry timed out'));
        }, FAST_LIMIT_MS);
        worker.once('message', (message) => {
            clearTimeout(timer);
            worker.terminate();
            if (message.ok)
                resolve(message.type);
            else
                reject(new Error(message.message));
        });
        worker.once('error', (error) => {
            clearTimeout(timer);
            worker.terminate();
            reject(error);
        });
    });
}

function hostKey() {
    const seed = kp.generateSeed({ algorithm: 'ecdsa-secp256k1' });
    return kp.deriveKeypair(seed);
}
