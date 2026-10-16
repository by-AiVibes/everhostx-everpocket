export function requireMaxInputLedgerOffset(config: { max_input_ledger_offset?: number }): number {
    const v = config.max_input_ledger_offset;
    if (v === undefined || v === null)
        throw new Error('Missing max_input_ledger_offset in contract config');
    return v;
}

export function requireCheckpointInterval(config: { evernode?: { checkpointInterval?: number } }): number {
    const v = config.evernode?.checkpointInterval;
    if (v === undefined || v === null || v <= 0)
        throw new Error('Missing evernode.checkpointInterval in contract config');
    return v;
}

export function requireCheckpointWindow(config: { evernode?: { checkpointWindow?: number } }): number {
    const v = config.evernode?.checkpointWindow;
    if (v === undefined || v === null || v <= 0)
        throw new Error('Missing evernode.checkpointWindow in contract config');
    return v;
}
