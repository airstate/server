import { createServer } from 'node:http';
// import { WebSocket, WebSocketServer } from 'ws';
// import { nanoid } from 'nanoid';
import express from 'express';
// import cookie from 'cookie';
// import { returnOf } from 'scope-utilities';
// import { AckPolicy, DeliverPolicy, headers } from 'nats';
// import { createHash } from 'crypto';
// import { getInitialState } from './shared-state/state.mjs';
import { createServices } from './services.mjs';
// import { TClientMeta } from './types/ws.mjs';
// import { configSchema } from './schema/config.mjs';
// import { handleSharedStateWS } from './shared-state/server.mjs';
import { httpContextCreatorFactory } from './api/trpc/context.mjs';
import { registerHTTPRoutes } from './api/http/index.mjs';
import { WebSocketServer } from 'ws';
import { logger } from './logger.mjs';
import { env } from './env.mjs';
import { registerWSHandlers } from './api/websocket/index.mjs';

const services = await createServices();
const expressApp = express();

// separate HTTP server instance to share
// server instance between express and ws server
const server = createServer(expressApp);

const wsServer = new WebSocketServer({
    server: server,
    path: '/ws',
});

const createHTTPContext = await httpContextCreatorFactory(services);

logger.debug('registering http routes');
await registerHTTPRoutes(expressApp, createHTTPContext);

logger.debug('attaching ws handlers');
await registerWSHandlers(wsServer, createHTTPContext);

const port = parseInt(env.AIRSTATE_PORT);

server.listen(port, '0.0.0.0', () => {
    logger.info(`🚂 express: listening on http://0.0.0.0:${port}/`, {
        port: port,
    });
});

export { TAppRouter } from './api/trpc/routers/index.mjs';
// // Basic route for health check
// app.get('/', (req, res) => {
//     res.json({ status: 'ok', service: 'airstate-server' });
// });
//
// const webSocketServer = new WebSocketServer({
//     path: '/connect',
//     noServer: true,
// });
//
// const clientMeta = new WeakMap<WebSocket, TClientMeta>();
//
// server.on('upgrade', async (request, socket, head) => {
//     if (webSocketServer.shouldHandle(request)) {
//         const url = new URL(`https://airstate${request.url}`);
//
//         const [appKey, resolvedConfig] = await returnOf(async () => {
//             const appKey = url.searchParams.get('app-key')?.trim();
//
//             if (appKey) {
//                 try {
//                     const configRequestURL = new URL(`${env.CONFIG_API_URL}/http/getConfigFromKey`);
//                     configRequestURL.searchParams.set('appKey', appKey);
//
//                     const configRequest = await fetch(`${configRequestURL}`);
//                     return [appKey, configSchema.parse(await configRequest.json())];
//                 } catch (error) {
//                     logger.warn(`could not get config for ${appKey}, using defaults`, error);
//                     return [appKey, null];
//                 }
//             } else {
//                 return [null, {}];
//             }
//         });
//
//         if (resolvedConfig) {
//             const cookies = cookie.parse(request.headers.cookie ?? '');
//
//             const clientIdentifier =
//                 'airstate_client_identifier' in cookies && cookies.airstate_client_identifier
//                     ? cookies.airstate_client_identifier
//                     : nanoid();
//
//             webSocketServer.once('headers', (headers, request) => {
//                 if (!('airstate_client_identifier' in cookies) || !cookies.airstate_client_identifier) {
//                     headers.push(
//                         `Set-Cookie: airstate_client_identifier=${clientIdentifier}; Path=/; Domain=; HttpOnly; SameSite=None; Secure`,
//                     );
//                 }
//             });
//
//             webSocketServer.handleUpgrade(request, socket, head, (ws) => {
//                 clientMeta.set(ws, {
//                     targetHost: request.headers.host,
//                     origin: request.headers.origin,
//                     connectionID: nanoid(),
//                     appKey: appKey,
//                     clientIdentifier: clientIdentifier,
//                     config: resolvedConfig,
//                 });
//
//                 webSocketServer.emit('connection', ws, request);
//             });
//         } else {
//             socket.end();
//         }
//     } else {
//         socket.end();
//     }
// });
//
// export function send(ws: WebSocket, message: string) {
//     try {
//         if (ws.readyState === WebSocket.OPEN) {
//             ws.send(message);
//             return true;
//         } else {
//             return false;
//         }
//     } catch (error) {
//         logger.error(`could not send message`, error);
//         return false;
//     }
// }
//
// webSocketServer.on('connection', async (ws, request) => {
//     const meta = clientMeta.get(ws)!;
//     const publishHeaders = headers();
//     publishHeaders.set('connID', meta.connectionID);
//
//     if (meta.origin && meta.origin.includes('localhost')) {
//         if (
//             !send(
//                 ws,
//                 JSON.stringify({
//                     type: 'console',
//                     level: 'warn',
//                     logs: [
//                         '%cNote: You are using a very early preview version of AirState',
//                         'padding: 0.5rem 0 0.5rem 0;',
//                     ],
//                 }),
//             )
//         ) {
//             return;
//         }
//     }
//
//     if (meta.config.connection_messages) {
//         for (const connectionMessage of meta.config.connection_messages) {
//             if (
//                 !send(
//                     ws,
//                     JSON.stringify({
//                         type: 'console',
//                         level: connectionMessage.level,
//                         logs: connectionMessage.arguments,
//                     }),
//                 )
//             ) {
//                 return;
//             }
//         }
//     }
//
//     if (meta.config.connection_error) {
//         if (
//             !send(
//                 ws,
//                 JSON.stringify({
//                     type: 'error',
//                     message: meta.config.connection_error,
//                 }),
//             )
//         ) {
//             return;
//         }
//     }
//
//     if (meta.config.close_after_init) {
//         if (ws.readyState === WebSocket.OPEN) {
//             ws.close();
//         }
//
//         return;
//     }
//
//     handleSharedStateWS(services, ws, meta);
//
//     const clientSentKey: string = url.searchParams.get('key') as string;
//
//     if (!clientSentKey) {
//         ws.close();
//         return;
//     }
//
//     ws.on('message', async (message) => {});
//
//     ws.on('close', async () => {
//         logger.info('closing connection');
//
//         try {
//             await services.jetStreamManager.consumers.delete(streamName, consumerName);
//         } catch (err) {
//             logger.error('Error deleting consumer:', err);
//         }
//     });
//
//     ws.on('error', (err) => {
//         logger.error('WebSocket error:', err);
//     });
// });
//
// const port = parseInt(env.SOCKET_SERVER_PORT);
//
// server.listen(port, () => {
//     logger.debug(`YJS server listening on port ${port}`);
// });
