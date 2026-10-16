import { createHash } from 'crypto';
import { SignerListInfo } from '../models';

export const DEFAULT_CHECKPOINT_INTERVAL = 10;
export const DEFAULT_CHECKPOINT_WINDOW = 3;

export function computeCheckpointIndexes(
    latestValidated: number,
    interval: number,
    window: number,
): number[] {
    if (latestValidated <= 0 || interval <= 0 || window <= 0)
        return [];
    const base = Math.floor(latestValidated / interval) * interval;
    const out: number[] = [];
    for (let i = 0; i < window; i++) {
        const idx = base - i * interval;
        if (idx > 0)
            out.push(idx);
    }
    return out;
}

export function hashSignerList(info: SignerListInfo | null): string | null {
    if (!info)
        return null;
    const signerList = [...info.signerList].sort((a, b) => a.account.localeCompare(b.account));
    const canonical = JSON.stringify({ signerQuorum: info.signerQuorum, signerList });
    return createHash('sha256').update(canonical).digest('hex');
}
