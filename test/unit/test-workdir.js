const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '../..');
const DEFAULT_WORK_ROOT = path.join(REPO_ROOT, 'test', '.work');

function resolveWorkRoot(overrideRoot) {
    const root = overrideRoot ? path.resolve(overrideRoot) : DEFAULT_WORK_ROOT;
    fs.mkdirSync(root, { recursive: true });
    return root;
}

/**
 * @param {string} prefix
 * @param {string} [workRoot]
 * @returns {string} absolute path to an empty work directory
 */
function createWorkDir(prefix, workRoot) {
    const root = resolveWorkRoot(workRoot);
    return fs.mkdtempSync(path.join(root, `${prefix}-`));
}

module.exports = {
    REPO_ROOT,
    DEFAULT_WORK_ROOT,
    createWorkDir,
};
