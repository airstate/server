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
  NatsError,
} from "nats";

const sc = StringCodec();
const nc = await connect({ servers: env.NATS_URL });
const js = nc.jetstream();
const jsm = await nc.jetstreamManager();
const kv = await nc
  .jetstream()
  .views.kv("use-shared-state", { storage: StorageType.Memory });

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

async function getMergedUpdate(
  streamName: string,
  lastSeq: number,
  lastMergedUpdate: string
): Promise<[string, number]> {
  const ephemeralConsumerName = `coordinator_consumer_${nanoid()}`;
  await jsm.consumers.add(streamName, {
    name: ephemeralConsumerName,
    deliver_policy: DeliverPolicy.StartSequence,
    opt_start_seq: lastSeq + 1,
    ack_policy: AckPolicy.None,
  });
  let lastMerged: Uint8Array = Uint8Array.from(
    Buffer.from(lastMergedUpdate, "base64")
  );
  let currSeq = lastSeq;

  const c = await js.consumers.get(streamName, ephemeralConsumerName);

  while (true) {
    let updates: Uint8Array[] = [];
    let messages = await c.fetch({
      max_messages: 1000,
      expires: 1000,
    });
    for await (const msg of messages) {
      updates.push(Uint8Array.from(Buffer.from(sc.decode(msg.data), "base64")));
      currSeq++;
    }
    lastMerged = Y.mergeUpdatesV2([lastMerged, ...updates]);
    if (updates.length < 1000) {
      break;
    }
  }
  await jsm.consumers.delete(streamName, ephemeralConsumerName);
  return [Buffer.from(lastMerged).toString("base64"), currSeq];
}

async function getInitialState(
  streamName: string,
  subject: string,
  clientSentInitialState: string
): Promise<[string, number, boolean]> {
  try {
    await kv.create(
      `${streamName}__coordinator`,
      JSON.stringify({
        lastSeq: 0,
        lastMergedUpdate: clientSentInitialState,
      })
    );
    await jsm.streams.add({
      name: streamName,
      subjects: [subject],
      storage: StorageType.Memory,
      max_msgs_per_subject: -1,
    });
    return [clientSentInitialState, 0, true];
  } catch (err) {
    if (
      err instanceof NatsError &&
      err.code === "400" &&
      err.message.includes("wrong last sequence")
    ) {
      const coordinatorValue = await kv.get(`${streamName}__coordinator`);
      if (coordinatorValue && coordinatorValue.string()) {
        const coordinatorValueJSON = JSON.parse(coordinatorValue.string()) as {
          lastSeq: number;
          lastMergedUpdate: string;
        };
        try {
          const [mergedUpdate, lastSeq] = await getMergedUpdate(
            streamName,
            coordinatorValueJSON.lastSeq,
            coordinatorValueJSON.lastMergedUpdate
          );
          await kv.put(
            `${streamName}__coordinator`,
            JSON.stringify({
              lastSeq,
              lastMergedUpdate: mergedUpdate,
            })
          );
          return [mergedUpdate, lastSeq, false];
        } catch (mergeErr) {
          if (
            mergeErr instanceof NatsError &&
            mergeErr.code === "404" &&
            mergeErr.message.includes("stream not found")
          ) {
            await kv.delete(`${streamName}__coordinator`);
          }
          throw mergeErr;
        }
      }
    }
    throw err;
  }
}

wss.on("connection", async (ws, request) => {
  const url = new URL(`https://airstate${request.url}`);
  const connID = nanoid();
  const h = headers();
  h.set("connID", connID);
  const accountID = connectionAccountIDs.get(ws);

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

  ws.on("message", async (message) => {
    const m = JSON.parse(message.toString("utf-8"));
    if (m.type === "init") {
      try {
        const [initialState, lastSeq, isFirst] = await getInitialState(
          streamName,
          subject,
          m.initialEncodedState
        );

        if (isFirst) {
          ws.send(
            JSON.stringify({
              type: "first",
            })
          );
        } else {
          ws.send(
            JSON.stringify({
              type: "init",
              initialEncodedState: initialState,
            })
          );
        }
        await jsm.consumers.add(streamName, {
          name: consumerName,
          ack_policy: AckPolicy.Explicit,
          deliver_policy: DeliverPolicy.StartSequence,
          opt_start_seq: lastSeq + 1,
        });
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
      } catch (err) {
        logger.error("Error processing initial state:", err);
        ws.send(
          JSON.stringify({
            type: "error",
            message: "Failed to process initial state",
          })
        );
        ws.close();
      }
    } else if (m.type === "update") {
      try {
        await js.publish(subject, sc.encode(m.encodedUpdate), {
          headers: h,
        });
      } catch (err) {
        logger.error("Failed to publish update:", err);
      }
    }
  });

  ws.on("close", async () => {
    logger.info("closing connection");
    try {
      await jsm.consumers.delete(streamName, consumerName);
    } catch (err) {
      logger.error("Error deleting consumer:", err);
    }
  });

  ws.on("error", (err) => {
    logger.error("WebSocket error:", err);
  });
});

server.listen(port, () => {
  logger.debug(`YJS server listening on port ${port}`);
});
