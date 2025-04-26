import { TConfig } from '../schema/config.mjs';

export type TClientMeta = {
    connectionID: string;
    origin?: string;
    targetHost?: string;
    appKey: string | null;
    clientIdentifier: string;
    config: TConfig;
};
