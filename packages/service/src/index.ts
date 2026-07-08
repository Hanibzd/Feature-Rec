#!/usr/bin/env -S node --experimental-sqlite
import { readEnv } from "./env";
import { buildServer } from "./http";
import { SqliteCycleStore } from "./storage/sqlite";

const env = readEnv();
const store = new SqliteCycleStore(env.dbPath);
const server = buildServer({ env, store });

const close = async () => {
  await server.close();
  await store.close();
};

process.once("SIGINT", () => {
  void close().finally(() => process.exit(0));
});
process.once("SIGTERM", () => {
  void close().finally(() => process.exit(0));
});

await server.listen({ port: env.port, host: "0.0.0.0" });
