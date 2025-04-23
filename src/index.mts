import { env } from './env.mjs';
import { logger } from './logger.mjs';
import { createServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { nanoid } from 'nanoid';
import express from 'express';
import cookie from 'cookie';
import { returnOf } from 'scope-utilities';
import { AckPolicy, DeliverPolicy, headers } from 'nats';
import { createHash } from 'crypto';
import { getInitialState } from './shared-state/state.mjs';
import { createServices } from './services.mjs';
import { TClientMeta } from './types/ws.mjs';
import { configSchema } from './schema/config.mjs';
import { tokenPayloadSchema } from './schema/tokenPayload.mjs';
import { NatsError } from 'nats';
import jwt from 'jsonwebtoken';

const services = await createServices();

// Create Express app
const app = express();
const server = createServer(app);

// Basic route for health check
app.get('/', (req, res) => {
    res.json({ status: 'ok', service: 'airstate-server' });
});

const webSocketServer = new WebSocketServer({
    path: '/connect',
    noServer: true,
});

const clientMeta = new WeakMap<WebSocket, TClientMeta>();

server.on('upgrade', async (request, socket, head) => {
    if (webSocketServer.shouldHandle(request)) {
        const cookies = cookie.parse(request.headers.cookie ?? '');

        const resolvedConfig = await returnOf(async () => {
            const url = new URL(`https://airstate${request.url}`);
            const appKey = url.searchParams.get('app-key')?.trim();
            const joiningToken = url.searchParams.get('joining-token');

            if (appKey) {
                try {
                    const configRequestURL = new URL(`${env.CONFIG_API_URL}/http/getConfigFromKey`);
                    configRequestURL.searchParams.set('appKey', appKey);

                    if (joiningToken) {
                        configRequestURL.searchParams.set('joiningToken', joiningToken);
                    }
                    const configRequest = await fetch(`${configRequestURL}`);
                    return configSchema.parse(await configRequest.json());
                } catch (error) {
                    logger.error(`could not get config for ${appKey}`, error);
                    return {};
                }
            } else {
                return {};
            }
        });

        if (resolvedConfig) {
            const clientIdentifier =
                'airstate_client_identifier' in cookies && cookies.airstate_client_identifier
                    ? cookies.airstate_client_identifier
                    : nanoid();

            webSocketServer.once('headers', (headers, request) => {
                if (!('airstate_client_identifier' in cookies) || !cookies.airstate_client_identifier) {
                    headers.push(
                        `Set-Cookie: airstate_client_identifier=${clientIdentifier}; Path=/; Domain=; HttpOnly; SameSite=None; Secure`,
                    );
                }
            });

            webSocketServer.handleUpgrade(request, socket, head, (ws) => {
                clientMeta.set(ws, {
                    clientIdentifier: clientIdentifier,
                    config: resolvedConfig,
                });

                webSocketServer.emit('connection', ws, request);
            });
        } else {
            socket.end();
        }
    } else {
        socket.end();
    }
});

function validateToken(token: string, signingSecret: string) {
    try {
        const decodedToken = jwt.verify(token, signingSecret);
        const parsedToken = tokenPayloadSchema.parse(decodedToken);
        return parsedToken.permission;
    } catch (error) {
        logger.error(`Token validation failed`, error);
        return null;
    }
}

export function send(ws: WebSocket, message: string) {
    try {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(message);
            return true;
        } else {
            return false;
        }
    } catch (error) {
        logger.error(`could not send message`, error);
        return false;
    }
}

webSocketServer.on('connection', async (ws, request) => {
    const url = new URL(`https://airstate${request.url}`);
    const connID = nanoid();
    const publishHeaders = headers();
    publishHeaders.set('connID', connID);

    const meta = clientMeta.get(ws)!;

    if (url.searchParams.has('host') && url.searchParams.get('host')!.indexOf('localhost') > -1) {
        if (
            !send(
                ws,
                JSON.stringify({
                    type: 'console',
                    level: 'warn',
                    logs: [
                        '%cNote: You are using a very early preview version of AirState',
                        'padding: 0.5rem 0 0.5rem 0;',
                    ],
                }),
            )
        ) {
            return;
        }
    }

    if (meta.config.init_logs) {
        for (const initialLog of meta.config.init_logs) {
            if (
                !send(
                    ws,
                    JSON.stringify({
                        type: 'console',
                        level: initialLog.level,
                        logs: initialLog.arguments,
                    }),
                )
            ) {
                return;
            }
        }
    }

    if (meta.config.init_error) {
        if (
            !send(
                ws,
                JSON.stringify({
                    type: 'error',
                    message: meta.config.init_error,
                }),
            )
        ) {
            return;
        }
    }

    if (meta.config.close_after_init) {
        if (ws.readyState === WebSocket.OPEN) {
            ws.close();
        }

        return;
    }

    const clientSentKey: string = url.searchParams.get('key') as string;
    const hashedClientSentKey: string = createHash('sha256').update(clientSentKey).digest('hex');

    if (!clientSentKey) {
        ws.close();
        return;
    }

    const clientSentToken = url.searchParams.get('joining-token');
    const defaultStatePermission = meta.config.default_state_permission ?? env.DEFAULT_STATE_PERMISSION;
    const signingSecret = meta.config.signing_secret ?? env.SHARED_SIGNING_KEY;
    const permissionRequiresAuth = defaultStatePermission === 'none' || defaultStatePermission === 'read';

    if (permissionRequiresAuth && !signingSecret) {
        send(
            ws,
            JSON.stringify({
                type: 'error',
                message: 'No signing secret provided but is required if default state permission is read or none',
            }),
        );
        logger.error('No signing secret provided but is required if default state permission is read or none');
        ws.close();
        return;
    }

    if (permissionRequiresAuth && !clientSentToken) {
        send(
            ws,
            JSON.stringify({
                type: 'error',
                message: 'You must provide a valid signed token',
            }),
        );
        logger.error('No token provided by the client but is required if default state permission is read or none');
        ws.close();
        return;
    }

    const clientPermission = permissionRequiresAuth
        ? validateToken(clientSentToken as string, signingSecret as string)
        : defaultStatePermission;

    if (!clientPermission && defaultStatePermission === 'none') {
        send(
            ws,
            JSON.stringify({
                type: 'error',
                message: 'Invalid token provided. Permission denied',
            }),
        );
        ws.close();
        return;
    }

    const canWrite = clientPermission === 'read-write';

    const key = `${meta.config.accounting_identifier}__${hashedClientSentKey}`;

    const streamName = key;
    const subject = `room.${key}`;
    const consumerName = `consumer_${connID}`;

    ws.on('message', async (message) => {
        const wsMessage = JSON.parse(message.toString('utf-8'));

        if (wsMessage.type === 'init') {
            if (!canWrite) {
                try {
                    await services.jetStreamManager.streams.info(streamName);
                } catch (err) {
                    if (err instanceof NatsError && err.code === '404' && err.api_error?.err_code === 10059) {
                        ws.send(
                            JSON.stringify({
                                type: 'console',
                                level: 'warn',
                                logs: [
                                    '%cNote: There is still no update in this room to read.',
                                    'padding: 0.5rem 0 0.5rem 0;',
                                ],
                            }),
                        );
                        return;
                    }
                }
            }
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
        } else if (wsMessage.type === 'update' && canWrite) {
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
