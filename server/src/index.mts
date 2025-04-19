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

const connIDMap = new WeakMap<WebSocket, string>();

function getStreamName(accountID: string, key: string) {
  return `${accountID}_${key}`;
}

async function ensureStream(streamName: string, subject: string) {
  try {
    await jsm.streams.info(streamName);
  } catch (err) {
    const streamConfig = {
      name: streamName,
      subjects: [subject],
      storage: StorageType.File,
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
    console.log("err on create consumer", err);
    throw err;
  }
}

async function getInitialState(stream: string) {
  const info = await jsm.streams
    .getMessage(stream, { seq: 1 })
    .catch(() => null);

  if (!info) {
    return [];
  }
  const messages = [];
  let seq = 1;
  while (true) {
    try {
      const m = await jsm.streams.getMessage(stream, { seq });
      const encodedUpdateB64 = sc.decode(m.data);
      const b = Buffer.from(encodedUpdateB64, "base64");
      const uint8arr = Uint8Array.from(b);
      messages.push(uint8arr);
      seq++;
    } catch {
      break;
    }
  }
  return messages;
}

wss.on("connection", async (ws, request) => {
  const url = new URL(`https://airstate${request.url}`);
  const connID = nanoid();
  connIDMap.set(ws, connID);
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
  const streamName = getStreamName(accountID || "test", key);
  const subject = `room.${accountID}_${key}`;
  const consumerName = `consumer_${connID}`;

  ws.on("message", async (message) => {
    const m = JSON.parse(message.toString("utf-8"));
    console.log("MESSAGE>>>>>>>>", m);
    if (m.type === "init") {
      console.log("entered init block");
      const initialStates = await getInitialState(streamName);
      if (initialStates.length === 0) {
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
          console.error("Error publishing initial state:", err);
          ws.send(
            JSON.stringify({
              type: "error",
              message: "Failed to publish initial state",
            })
          );
        }
      } else {
        const mergedUpdates = Y.mergeUpdatesV2(initialStates);
        ws.send(
          JSON.stringify({
            type: "init",
            initialEncodedState: Buffer.from(mergedUpdates).toString("base64"),
          })
        );
      }
    } else if (m.type === "update") {
      try {
        await js.publish(subject, sc.encode(m.encodedUpdate), {
          headers: h,
        });
      } catch (err) {
        console.log(err);
      }
    }
  });

  ws.on("close", async () => {
    try {
      // Delete the consumer from NATS
      await jsm.consumers.delete(streamName, consumerName);
      console.log("Consumer deleted successfully");
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
