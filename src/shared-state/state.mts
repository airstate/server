import { JetStreamClient, JetStreamManager, KV, NatsError, StorageType } from 'nats';
import { getMergedUpdate } from './updates.mjs';

export async function getInitialState(
    jetStreamClient: JetStreamClient,
    jetStreamManager: JetStreamManager,
    jetStreamKV: KV,
    streamName: string,
    subject: string,
    clientSentInitialState: string,
): Promise<[string, number, boolean]> {
    try {
        await jetStreamKV.create(
            `${streamName}__coordinator`,
            JSON.stringify({
                lastSeq: 0,
                lastMergedUpdate: clientSentInitialState,
            }),
        );

        await jetStreamManager.streams.add({
            name: streamName,
            subjects: [subject],
            storage: StorageType.File,
            max_msgs_per_subject: -1,
        });

        return [clientSentInitialState, 0, true];
    } catch (err) {
        if (err instanceof NatsError && err.code === '400' && err.message.includes('wrong last sequence')) {
            const coordinatorValue = await jetStreamKV.get(`${streamName}__coordinator`);

            if (coordinatorValue && coordinatorValue.string()) {
                const coordinatorValueJSON = JSON.parse(coordinatorValue.string()) as {
                    lastSeq: number;
                    lastMergedUpdate: string;
                };

                try {
                    const [mergedUpdate, lastSeq] = await getMergedUpdate(
                        jetStreamClient,
                        jetStreamManager,
                        streamName,
                        coordinatorValueJSON.lastSeq,
                        coordinatorValueJSON.lastMergedUpdate,
                    );

                    await jetStreamKV.put(
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
                        mergeErr.message.includes('stream not found')
                    ) {
                        await jetStreamKV.delete(`${streamName}__coordinator`);
                    }

                    throw mergeErr;
                }
            }
        }

        throw err;
    }
}
