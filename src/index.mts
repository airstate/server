import { env } from './env.mjs';
import { logger } from './logger.mjs';
import { createServer } from 'node:http';
import { type WebSocket, WebSocketServer } from 'ws';
import { nanoid } from 'nanoid';
import express from 'express';
import cookie from 'cookie';
import { returnOf } from 'scope-utilities';
import { AckPolicy, connect, DeliverPolicy, headers, StorageType, StringCodec } from 'nats';
import { createHash } from 'crypto';
import { getInitialState } from './shared-state/state.mjs';
import { createServices } from './services.mjs';

const services = await createServices();

// Create Express app
const app = express();
const server = createServer(app);

// Basic route for health check
app.get('/', (req, res) => {
    res.json({ status: 'ok', service: 'airstate-server' });
});

const webSocketServer = new WebSocketServer({
    noServer: true,
});

const clientIdentifiers = new WeakMap<WebSocket, string>();
const connectionAccountIDs = new WeakMap<WebSocket, string | null | undefined>();

server.on('upgrade', async (request, socket, head) => {
    const url = new URL(`https://airstate${request.url}`);
    const cookies = cookie.parse(request.headers.cookie ?? '');

    const clientIdentifier =
        'airstate_client_identifier' in cookies && cookies.airstate_client_identifier
            ? cookies.airstate_client_identifier
            : nanoid();

    const accountID = await returnOf(async () => {
        if (url.searchParams.has('app-key') && url.searchParams.get('app-key')) {
            try {
                const checkerRequest = await fetch(
                    `${env.CONFIG_API_URL}/http/getConfigFromKey?appKey=${url.searchParams.get('app-key')}`,
                );

                const checkerResponse = await checkerRequest.json();
                return checkerResponse.data.userId as string;
            } catch {
                return null;
            }
        } else {
            return undefined;
        }
    });

    if (url.pathname.startsWith('/y/')) {
        webSocketServer.once('headers', (headers, request) => {
            if (!('airstate_client_identifier' in cookies) || !cookies.airstate_client_identifier) {
                headers.push(
                    `Set-Cookie: airstate_client_identifier=${clientIdentifier}; Path=/; Domain=; HttpOnly; SameSite=None; Secure`,
                );
            }
        });

        webSocketServer.handleUpgrade(request, socket, head, (ws) => {
            clientIdentifiers.set(ws, clientIdentifier);
            connectionAccountIDs.set(ws, accountID);

            webSocketServer.emit('connection', ws, request);
        });
    } else {
        socket.end();
    }
});

webSocketServer.on('connection', async (ws, request) => {
    const url = new URL(`https://airstate${request.url}`);
    const connID = nanoid();

    const publishHeaders = headers();
    publishHeaders.set('connID', connID);

    const accountID = connectionAccountIDs.get(ws);

    if (url.searchParams.has('host') && url.searchParams.get('host')!.indexOf('localhost') > -1) {
        ws.send(
            JSON.stringify({
                type: 'console',
                level: 'warn',
                logs: [
                    '%cNote: You are using a very early preview version of useSharedState by AirState.',
                    'padding: 0.5rem 0 0.5rem 0;',
                ],
            }),
        );
    }

    if (accountID === undefined) {
        ws.send(
            JSON.stringify({
                type: 'console',
                level: 'error',
                logs: [
                    '%cAirState: Please Set appKey\n%cGet your appKey from https://console.airstate.dev',
                    'font-size:1.5rem; font-weight: bold; padding: 1rem 0 0.3rem 0;',
                    'font-size:1rem; font-family: monospace; padding: 0 0 1rem 0;',
                ],
            }),
        );

        ws.send(
            JSON.stringify({
                type: 'error',
                message:
                    'You need to call `configure` with your `appKey`; Get your appKey from https://console.airstate.dev',
            }),
        );

        ws.close();

        return;
    }

    const clientSentKey: string = url.searchParams.get('key') as string;
    const hashedClientSentKey: string = createHash('sha256').update(clientSentKey).digest('hex');

    if (!clientSentKey) {
        ws.close();
        return;
    }

    const key = `${accountID}__${hashedClientSentKey}`;

    const streamName = key;
    const subject = `room.${key}`;
    const consumerName = `consumer_${connID}`;

    ws.on('message', async (message) => {
        const wsMessage = JSON.parse(message.toString('utf-8'));

        if (wsMessage.type === 'init') {
            try {
                const [initialState, lastSeq, isFirst] = await getInitialState(
                    services,
                    streamName,
                    subject,
                    wsMessage.initialEncodedState,
                );

                if (isFirst) {
                    ws.send(
                        JSON.stringify({
                            type: 'first',
                        }),
                    );
                } else {
                    ws.send(
                        JSON.stringify({
                            type: 'init',
                            initialEncodedState: initialState,
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

                    if (updateConnID !== connID) {
                        ws.send(
                            JSON.stringify({
                                type: 'update',
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
        } else if (wsMessage.type === 'update') {
            try {
                await services.jetStreamClient.publish(
                    subject,
                    services.natsStringCodec.encode(wsMessage.encodedUpdate),
                    {
                        headers: publishHeaders,
                    },
                );
            } catch (err) {
                logger.error('Failed to publish update:', err);
            }
        }
    });

    ws.on('close', async () => {
        logger.info('closing connection');

        try {
            await services.jetStreamManager.consumers.delete(streamName, consumerName);
        } catch (err) {
            logger.error('Error deleting consumer:', err);
        }
    });

    ws.on('error', (err) => {
        logger.error('WebSocket error:', err);
    });
});

const port = parseInt(env.SOCKET_SERVER_PORT);

server.listen(port, () => {
    logger.debug(`YJS server listening on port ${port}`);
});
