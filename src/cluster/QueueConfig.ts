export function requireMaxInputLedgerOffset(config: { max_input_ledger_offset?: number }): number {
    const v = config.max_input_ledger_offset;
    if (v === undefined || v === null)
        throw new Error('Missing max_input_ledger_offset in contract config');
    return v;
}
