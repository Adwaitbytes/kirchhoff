/**
 * Judge entry point: `node src/main.ts`. All configuration comes from the environment
 * (see judge/README.md); a bad config exits non-zero before the port opens.
 */
import { ConfigError, loadConfig, rpcFor } from "./config.ts";
import { createLogger } from "./log.ts";
import { createMetrics } from "./metrics.ts";
import { createProviders, type ChainProviders } from "./rpc.ts";
import { compileValidators } from "./schema.ts";
import { createJudgeServer } from "./server.ts";
import { VerdictSink } from "./sink.ts";
import { SpecCache, SpecLoadError, loadTokens } from "./spec-cache.ts";

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const logger = createLogger(config.logLevel);
  const tokens = loadTokens(config.specPaths, config.deploymentsPath);
  const chainNames = new Map<bigint, string>();
  for (const t of tokens) for (const c of t.chains.values()) chainNames.set(c.selector, c.name);
  const rpc = rpcFor(process.env, new Set(chainNames.values()));

  const providers = new Map<bigint, ChainProviders>();
  for (const [selector, name] of chainNames) {
    const urls = rpc.get(name);
    if (urls === undefined) throw new ConfigError(`no RPC for ${name}`);
    providers.set(selector, createProviders(name, urls, config.budgetMs));
  }
  const providersFor = (selector: bigint): ChainProviders | undefined => providers.get(selector);

  const cache = new SpecCache({
    tokens,
    providersFor: (selector) => {
      const p = providers.get(selector);
      if (p === undefined) throw new ConfigError(`no providers for registry chain ${selector.toString()}`);
      return p;
    },
    syncMs: config.specSyncMs,
    maxAgeMs: config.specMaxAgeMs,
    onSyncError: (token, note) => {
      logger.log("warn", "spec cache sync failed", { token: token.symbol, note });
    },
  });
  await cache.syncOnce();
  cache.start();

  const metrics = createMetrics();
  const sinkConfig = config.verdictSink;
  const sink =
    sinkConfig === null ? undefined : new VerdictSink({ url: sinkConfig.url, key: sinkConfig.key, metrics: metrics.sink, logger });
  sink?.start();
  const server = createJudgeServer({
    cache,
    providersFor,
    auth: config.auth,
    basePath: config.basePath,
    budgetMs: config.budgetMs,
    validators: compileValidators(),
    metrics,
    logger,
    ...(sink === undefined || sinkConfig === null
      ? {}
      : { verdictSink: { sink, cellId: sinkConfig.cellId, specSelectors: new Set([...chainNames.keys()].map((k) => k.toString())) } }),
  });
  server.listen(config.port, config.host, () => {
    logger.log("info", "judge listening", {
      host: config.host,
      port: config.port,
      evaluatePath: `${config.basePath}/v1/evaluate`,
      auth: config.auth.mode,
      budgetMs: config.budgetMs,
      verdictSink: sinkConfig === null ? "off" : sinkConfig.url,
      tokens: tokens.map((t) => ({ symbol: t.symbol, tokenId: t.tokenId, cachedSpecHash: t.cachedSpecHash, active: cache.active(t.tokenId) })),
    });
    if (config.auth.mode === "insecure") {
      logger.log("warn", "HMAC verification disabled (JUDGE_AUTH_MODE=insecure); expose the Judge only to its verifier");
    }
  });

  const shutdown = (signal: string): void => {
    logger.log("info", "shutting down", { signal });
    cache.stop();
    sink?.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGTERM", () => {
    shutdown("SIGTERM");
  });
  process.on("SIGINT", () => {
    shutdown("SIGINT");
  });
}

main().catch((e: unknown) => {
  const known = e instanceof ConfigError || e instanceof SpecLoadError;
  process.stderr.write(
    `${JSON.stringify({ ts: new Date().toISOString(), level: "error", msg: "judge failed to start", error: known ? (e as Error).message : e instanceof Error ? e.stack : String(e) })}\n`,
  );
  process.exit(1);
});
