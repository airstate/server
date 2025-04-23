import { NatsError, StorageType } from 'nats';
import { getMergedUpdate } from './updates.mjs';
import { NATSServices } from '../types/nats.mjs';

export async function getInitialState(
    nats: NATSServices,
    streamName: string,
    subject: string,
    clientSentInitialState: string,
): Promise<[string, number, boolean]> {
    try {
        await nats.sharedStateKV.create(
            `${streamName}__coordinator`,
            JSON.stringify({
                lastSeq: 0,
                lastMergedUpdate: clientSentInitialState,
            }),
        );

        await nats.jetStreamManager.streams.add({
            name: streamName,
            subjects: [subject],
            storage: StorageType.File,
            max_msgs_per_subject: -1,
        });

        return [clientSentInitialState, 0, true];
    } catch (err) {
        if (err instanceof NatsError && err.code === '400' && err.api_error?.err_code === 10071) {
            const coordinatorValue = await nats.sharedStateKV.get(`${streamName}__coordinator`);

            if (coordinatorValue && coordinatorValue.string()) {
                const coordinatorValueJSON = JSON.parse(coordinatorValue.string()) as {
                    lastSeq: number;
                    lastMergedUpdate: string;
                };

                try {
                    const [mergedUpdate, lastSeq] = await getMergedUpdate(
                        nats,
                        streamName,
                        coordinatorValueJSON.lastSeq,
                        coordinatorValueJSON.lastMergedUpdate,
                    );

                    await nats.sharedStateKV.put(
                        `${streamName}__coordinator`,
                        JSON.stringify({
                            lastSeq,
                            lastMergedUpdate: mergedUpdate,
                        }),
                    );

                    return [mergedUpdate, lastSeq, false];
                } catch (mergeErr) {
                    if (
                        mergeErr instanceof NatsError &&
                        mergeErr.code === '404' &&
                        mergeErr.api_error?.err_code === 10059
                    ) {
                        await nats.sharedStateKV.delete(`${streamName}__coordinator`);
                    }

                    throw mergeErr;
                }
            }
        }

        throw err;
    }
}
