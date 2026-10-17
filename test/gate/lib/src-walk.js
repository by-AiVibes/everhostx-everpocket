'use strict';
const fs = require('fs');
const path = require('path');
const { SRC } = require('./env');

function walkTs(dir = SRC) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory())
            return walkTs(full);
        return entry.name.endsWith('.ts') ? [full] : [];
    });
}

function relSrc(file) {
    return path.relative(SRC, file).split(path.sep).join('/');
}

module.exports = { walkTs, relSrc };
