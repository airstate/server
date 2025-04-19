import { env } from "./env.mjs";
import { logger } from "./logger.mjs";
import { createServer } from "node:http";
import { type WebSocket, WebSocketServer } from "ws";
import * as Y from "yjs";
import { nanoid } from "nanoid";
import express from "express";
import cookie from "cookie";
import { returnOf } from "scope-utilities";
import {
  connect,
  StringCodec,
  StorageType,
  AckPolicy,
  DeliverPolicy,
  headers,
} from "nats";

const sc = StringCodec();
const nc = await connect({ servers: env.NATS_URL });
const js = nc.jetstream();
const jsm = await nc.jetstreamManager();
const kv = await nc.jetstream().views.kv("airstate");

// Create Express app
const app = express();
const server = createServer(app);

// Basic route for health check
app.get("/", (req, res) => {
  res.json({ status: "ok", service: "airstate-socket-server" });
});

const port = parseInt(env.SOCKET_SERVER_PORT);

const wss = new WebSocketServer({
  noServer: true,
});

const clientIdentifiers = new WeakMap<WebSocket, string>();
const connectionAccountIDs = new WeakMap<
  WebSocket,
  string | null | undefined
>();

server.on("upgrade", async (request, socket, head) => {
  const url = new URL(`https://airstate${request.url}`);
  const cookies = cookie.parse(request.headers.cookie ?? "");

  const clientIdentifier =
    "airstate_client_identifier" in cookies &&
    cookies.airstate_client_identifier
      ? cookies.airstate_client_identifier
      : nanoid();

  const accountID = await returnOf(async () => {
    if (url.searchParams.has("app-key") && url.searchParams.get("app-key")) {
      try {
        const checkerRequest = await fetch(
          `${
            env.CORE_API_BASE_URL
          }/http/getUserFromKey?appKey=${url.searchParams.get("app-key")}`
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

  if (url.pathname.startsWith("/y/")) {
    wss.once("headers", (headers, request) => {
      if (
        !("airstate_client_identifier" in cookies) ||
        !cookies.airstate_client_identifier
      ) {
        headers.push(
          `Set-Cookie: airstate_client_identifier=${clientIdentifier}; Path=/; Domain=; HttpOnly; SameSite=None; Secure`
        );
      }
    });

    wss.handleUpgrade(request, socket, head, (ws) => {
      clientIdentifiers.set(ws, clientIdentifier);
      connectionAccountIDs.set(ws, accountID);

      wss.emit("connection", ws, request);
    });
  } else {
    socket.end();
  }
});

async function ensureStream(streamName: string, subject: string) {
  try {
    await jsm.streams.info(streamName);
  } catch (err) {
    const streamConfig = {
      name: streamName,
      subjects: [subject],
      storage: StorageType.Memory,
      max_msgs_per_subject: -1,
    };
    await jsm.streams.add(streamConfig);
  }
}

async function createConsumer(stream: string, consumerName: string) {
  try {
    const consumer = await jsm.consumers.add(stream, {
      durable_name: consumerName,
      ack_policy: AckPolicy.Explicit,
      deliver_policy: DeliverPolicy.New,
    });
    return consumer;
  } catch (err) {
    logger.error("err on create consumer", err);
    throw err;
  }
}

async function getInitialState(stream: string): Promise<Uint8Array | null> {
  const checkpointKey = `checkpoint_${stream}`;
  const mergedStateKey = `merged_${stream}`;

  try {
    const checkpointEntry = await kv.get(checkpointKey);
    const mergedStateEntry = await kv.get(mergedStateKey);

    if (
      checkpointEntry &&
      mergedStateEntry &&
      checkpointEntry.string() &&
      mergedStateEntry.string()
    ) {
      const lastSeq = parseInt(checkpointEntry.string());

      const mergedState = Uint8Array.from(
        Buffer.from(mergedStateEntry.string(), "base64")
      );
      const newMessages = await getMessages(stream, lastSeq + 1);

      if (newMessages.length > 0) {
        const finalMerged = Y.mergeUpdatesV2([mergedState, ...newMessages]);
        await updateCheckpoint(
          stream,
          lastSeq + newMessages.length,
          finalMerged
        );

        return finalMerged;
      }

      return mergedState;
    }
  } catch (err) {
    logger.error("Error reading from KV store:", err);
  }

  const messages = await getMessages(stream, 1);
  if (messages.length > 0) {
    const merged = Y.mergeUpdatesV2(messages);
    await updateCheckpoint(stream, messages.length, merged);
    return merged;
  }

  return null;
}

async function getMessages(
  stream: string,
  startSeq: number
): Promise<Uint8Array[]> {
  const BATCH_SIZE = 1000;
  let seq = startSeq;
  const allMessages: Uint8Array[] = [];

  if (startSeq === 1) {
    const info = await jsm.streams
      .getMessage(stream, { seq: 1 })
      .catch(() => null);

    if (!info) {
      return [];
    }
  }

  while (true) {
    try {
      const messages = await Promise.all(
        Array.from({ length: BATCH_SIZE }, (_, i) =>
          jsm.streams.getMessage(stream, { seq: seq + i }).catch(() => null)
        )
      );

      const validMessages = messages.filter(
        (m): m is NonNullable<typeof m> => m !== null
      );

      if (validMessages.length === 0) {
        break;
      }

      const batchUpdates = validMessages.map((m) => {
        const encodedUpdateB64 = sc.decode(m.data);
        const b = Buffer.from(encodedUpdateB64, "base64");
        return Uint8Array.from(b);
      });

      allMessages.push(...batchUpdates);
      seq += validMessages.length;

      if (validMessages.length < BATCH_SIZE) {
        break;
      }
    } catch (err) {
      logger.error("Error processing messages:", err);
      break;
    }
  }

  return allMessages;
}

async function updateCheckpoint(
  stream: string,
  seq: number,
  mergedState: Uint8Array
): Promise<void> {
  const checkpointKey = `checkpoint_${stream}`;
  const mergedStateKey = `merged_${stream}`;

  try {
    await kv.put(checkpointKey, seq.toString());
    await kv.put(mergedStateKey, Buffer.from(mergedState).toString("base64"));
  } catch (err) {
    logger.error("Error updating checkpoint:", err);
  }
}

wss.on("connection", async (ws, request) => {
  const url = new URL(`https://airstate${request.url}`);
  const connID = nanoid();
  const h = headers();
  h.set("connID", connID);

  const accountID = connectionAccountIDs.get(ws);

  console.log("----------- tomato");

  if (
    url.searchParams.has("host") &&
    url.searchParams.get("host")!.indexOf("localhost") > -1
  ) {
    ws.send(
      JSON.stringify({
        type: "console",
        level: "warn",
        logs: [
          "%cNote: You are using a very early preview version of useSharedState by AirState.",
          "padding: 0.5rem 0 0.5rem 0;",
        ],
      })
    );
  }

  if (accountID === undefined) {
    ws.send(
      JSON.stringify({
        type: "console",
        level: "error",
        logs: [
          "%cAirState: Please Set appKey\n%cGet your appKey from https://console.airstate.dev",
          "font-size:1.5rem; font-weight: bold; padding: 1rem 0 0.3rem 0;",
          "font-size:1rem; font-family: monospace; padding: 0 0 1rem 0;",
        ],
      })
    );

    ws.send(
      JSON.stringify({
        type: "error",
        message:
          "You need to call `configure` with your `appKey`; Get your appKey from https://console.airstate.dev",
      })
    );

    ws.close();

    return;
  }

  const clientSentKey: string = url.searchParams.get("key") as string;
  if (!clientSentKey) {
    ws.close();
    return;
  }
  const key = `${accountID}__${clientSentKey}`;
  const streamName = key;
  const subject = `room.${key}`;
  const consumerName = `consumer_${connID}`;
  const keyConnections = new Map<string, Set<WebSocket>>();

  if (!keyConnections.has(key)) {
    keyConnections.set(key, new Set());
  }
  keyConnections.get(key)!.add(ws);

  ws.on("message", async (message) => {
    const m = JSON.parse(message.toString("utf-8"));
    if (m.type === "init") {
      const initialState = await getInitialState(streamName);
      if (!initialState) {
        try {
          await js.publish(subject, sc.encode(m.initialEncodedState), {
            headers: h,
          });
          ws.send(
            JSON.stringify({
              type: "first",
            })
          );
        } catch (err) {
          logger.error("Error publishing initial state:", err);
          ws.send(
            JSON.stringify({
              type: "error",
              message: "Failed to publish initial state",
            })
          );
        }
      } else {
        ws.send(
          JSON.stringify({
            type: "init",
            initialEncodedState: Buffer.from(initialState).toString("base64"),
          })
        );
      }
    } else if (m.type === "update") {
      try {
        await js.publish(subject, sc.encode(m.encodedUpdate), {
          headers: h,
        });
      } catch (err) {
        logger.info(err);
      }
    }
  });

  ws.on("close", async () => {
    logger.info("closing connection");
    try {
      await jsm.consumers.delete(streamName, consumerName);
      logger.info("Consumer deleted successfully");
      const connections = keyConnections.get(key);
      if (connections) {
        connections.delete(ws);
        if (connections.size === 0) {
          keyConnections.delete(key);
          try {
            await jsm.streams.delete(streamName);
            await kv.delete(`checkpoint_${streamName}`);
            await kv.delete(`merged_${streamName}`);
            logger.info(`Stream ${streamName} deleted successfully`);
          } catch (err) {
            logger.error("Error deleting stream:", err);
          }
        }
      }
    } catch (err) {
      logger.error("Error deleting consumer:", err);
    }
  });

  ws.on("error", (err) => {
    logger.error("WebSocket error:", err);
  });
  await ensureStream(streamName, subject);
  await createConsumer(streamName, consumerName);
  const c = await js.consumers.get(streamName, consumerName);
  const messages = await c.consume({ max_messages: 1 });
  for await (const m of messages) {
    const updateConnID = m.headers?.get("connID");
    if (updateConnID !== connID) {
      ws.send(
        JSON.stringify({
          type: "update",
          encodedUpdate: sc.decode(m.data),
        })
      );
    }
    m.ack();
  }
});

server.listen(port, () => {
  logger.debug(`YJS server listening on port ${port}`);
});
