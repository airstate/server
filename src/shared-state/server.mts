import { WebSocket } from 'ws';
import { TClientMeta } from '../types/ws.mjs';
import { getInitialState } from './state.mjs';
import { AckPolicy, DeliverPolicy } from 'nats';
import { logger } from '../logger.mjs';
import { TServices } from '../services.mjs';
import { z } from 'zod';
import { createHash } from 'crypto';
import { nanoid } from 'nanoid';

export const commonMessageFormat = z.object({
    message_id: z.string(),
});

export const sharedStateInitMessageSchema = commonMessageFormat.merge(
    z.object({
        key: z.string(),
        token: z.string().optional(),
        initialEncodedState: z.string(),
    }),
);

export function handleSharedStateWS(services: TServices, ws: WebSocket, meta: TClientMeta) {
    let i = 0;

    ws.on('message', async (rawMessage) => {
        const message = JSON.parse(rawMessage.toString('utf-8'));

        if (!message.type || typeof message.type !== 'string' || !message.type.startsWith('shared-state:')) {
            return;
        }

        if (message.type === 'shared-state:init') {
            const parsed = sharedStateInitMessageSchema.safeParse(message);

            if (!parsed.success) {
                ws.send(
                    JSON.stringify({
                        message_id: `${meta.connectionID}:${i++}`,
                        response_to: message.id,
                        errorCode: 'BAD_FORMAT',
                        errorMessage: 'your init message was malformed',
                        validationError: parsed.error,
                        type: 'shared-state:error',
                    }),
                );

                return;
            }

            const sessionID = nanoid();

            const parsedMessage = parsed.data;

            const clientSentKey = parsedMessage.key;
            const hashedClientSentKey: string = createHash('sha256').update(clientSentKey).digest('hex');
            const streamName = `${meta.config.accounting_identifier}__${hashedClientSentKey}`;
            const subject = `shared_state.${streamName}`;

            const consumerName = `shared_state_consumer__${sessionID}`;

            try {
                const [initialState, lastSeq, isFirst] = await getInitialState(
                    services,
                    streamName,
                    subject,
                    message.initialEncodedState,
                );

                if (isFirst) {
                    ws.send(
                        JSON.stringify({
                            message_id: `${meta.connectionID}:${i++}`,
                            response_to: message.id,
                            type: 'shared-state:first',
                            session_id: sessionID,
                        }),
                    );
                } else {
                    ws.send(
                        JSON.stringify({
                            message_id: `${meta.connectionID}:${i++}`,
                            response_to: message.id,
                            type: 'shared-state:init',
                            initialEncodedState: initialState,
                            session_id: sessionID,
                        }),
                    );
                }

                await services.jetStreamManager.consumers.add(streamName, {
                    name: consumerName,
                    ack_policy: AckPolicy.Explicit,
                    deliver_policy: DeliverPolicy.StartSequence,
                    opt_start_seq: lastSeq + 1,
                });

                const steamConsumer = await services.jetStreamClient.consumers.get(streamName, consumerName);

                const streamMessages = await steamConsumer.consume({
                    max_messages: 1,
                });

                for await (const streamMessage of streamMessages) {
                    const updateConnID = streamMessage.headers?.get('connID');

                    if (updateConnID !== meta.connectionID) {
                        ws.send(
                            JSON.stringify({
                                type: 'shared-state:update',
                                encodedUpdate: services.natsStringCodec.decode(streamMessage.data),
                            }),
                        );
                    }

                    streamMessage.ack();
                }
            } catch (err) {
                logger.error('Error processing initial state:', err);

                ws.send(
                    JSON.stringify({
                        type: 'error',
                        message: 'Failed to process initial state',
                    }),
                );

                ws.close();
            }
        } else if (message.type === 'shared-state:update') {
            try {
                await services.jetStreamClient.publish(
                    subject,
                    services.natsStringCodec.encode(message.encodedUpdate),
                    {
                        headers: publishHeaders,
                    },
                );
            } catch (err) {
                logger.error('Failed to publish update:', err);
            }
        }
    });
}
