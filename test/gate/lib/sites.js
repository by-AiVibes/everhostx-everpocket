'use strict';
const fs = require('fs');
const path = require('path');
const { SRC } = require('./env');
const { walkTs, relSrc } = require('./src-walk');

const REPO = path.resolve(__dirname, '..', '..', '..');

function lineIn(file, needle) {
    if (!fs.existsSync(file))
        return null;
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const index = lines.findIndex((line) => line.includes(needle));
    if (index < 0)
        return null;
    return index + 1;
}

function srcLine(rel, needle) {
    const found = lineIn(path.join(SRC, rel), needle);
    return `${rel}:${found || 1}`;
}

function repoLine(rel, needle) {
    const found = lineIn(path.join(REPO, rel), needle);
    return `${rel}:${found || 1}`;
}

function srcLineContaining(text) {
    const needle = String(text || '').trim();
    if (!needle)
        return null;
    for (const file of walkTs()) {
        const lines = fs.readFileSync(file, 'utf8').split('\n');
        const index = lines.findIndex((line) => line.includes(needle));
        if (index >= 0)
            return `${relSrc(file)}:${index + 1}`;
    }
    return null;
}

function extendSubmitSite() {
    const queue = path.join(SRC, 'cluster/OperationQueueProcessor.ts');
    if (fs.existsSync(queue) && fs.readFileSync(queue, 'utf8').includes('extendSubmit'))
        return srcLine('cluster/OperationQueueProcessor.ts', 'extendSubmit');
    return srcLine('context/ClusterContext.ts', 'evernodeContext.extendSubmit');
}

function quorumExtendSite() {
    const pinning = path.join(SRC, 'cluster/ExtendPinning.ts');
    if (fs.existsSync(pinning) && fs.readFileSync(pinning, 'utf8').includes('quorumExtendCompletesOp'))
        return srcLine('cluster/ExtendPinning.ts', 'function quorumExtendCompletesOp');
    return srcLine('context/ClusterContext.ts', 'async #processOperations');
}

function applyObservationSite() {
    const rel = 'cluster/AnchorObservation.ts';
    const file = path.join(SRC, rel);
    if (!fs.existsSync(file))
        return `${rel}:1`;
    const text = fs.readFileSync(file, 'utf8');
    if (text.includes('function applyObservationInputs'))
        return srcLine(rel, 'function applyObservationInputs');
    return `${rel}:1`;
}

function acquireMaterialSite() {
    const rel = 'context/EvernodeContext.ts';
    const lines = fs.readFileSync(path.join(SRC, rel), 'utf8').split('\n');
    const index = lines.findIndex((line) => /lclHash/.test(line) && /seed|iv|ephem|Buffer\.from/.test(line));
    if (index >= 0)
        return `${rel}:${index + 1}`;
    return srcLine(rel, 'acquireSubmit');
}

function submitRecorderSite() {
    const rel = 'context/EvernodeContext.ts';
    const lines = fs.readFileSync(path.join(SRC, rel), 'utf8').split('\n');
    const code = lines.findIndex((line) => line.includes('res.code'));
    if (code >= 0)
        return `${rel}:${code + 1}`;
    const result = lines.findIndex((line) => line.includes('resultCode') && line.includes('res.'));
    if (result >= 0)
        return `${rel}:${result + 1}`;
    return srcLine(rel, 'async extendSubmit');
}

function productionBackendSite() {
    const rel = 'context/XrplContext.ts';
    const lines = fs.readFileSync(path.join(SRC, rel), 'utf8').split('\n');
    const wired = lines.findIndex((line) => /xahauLedger\s*=/.test(line) && !/null/.test(line));
    if (wired >= 0)
        return `${rel}:${wired + 1}`;
    return srcLine(rel, 'constructor(');
}

module.exports = {
    srcLine,
    repoLine,
    srcLineContaining,
    extendSubmitSite,
    quorumExtendSite,
    applyObservationSite,
    acquireMaterialSite,
    submitRecorderSite,
    productionBackendSite,
};
