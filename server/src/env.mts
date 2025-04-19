import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
  server: {
    NODE_ENV: z.enum(["development", "production"]).default("development"),
    SOCKET_SERVER_PORT: z.string().default("12006"),
    CORE_API_BASE_URL: z.string().default("http://localhost:12002"),
    NATS_URL: z.string().default("nats://localhost:4222"),
  },
  runtimeEnv: process.env,
});
