import { ConfigError } from "./env.ts";
import { parseNetworkName, type NetworkName } from "./networks.ts";

export type Args = { network: NetworkName; options: ReadonlyMap<string, string>; flags: ReadonlySet<string> };

/** `--key value`, `--key=value` and bare `--flag`. A lone `--` (pnpm passthrough) is ignored. */
export function parseArgs(argv: readonly string[], known: { options: readonly string[]; flags: readonly string[] }): Args {
  const options = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === "--") continue;
    if (!arg.startsWith("--")) throw new ConfigError(`unexpected argument ${arg}`);
    const eq = arg.indexOf("=");
    const key = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    if (key === "network" || known.options.includes(key)) {
      const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
      if (value === undefined || value.startsWith("--")) throw new ConfigError(`--${key} needs a value`);
      options.set(key, value);
    } else if (known.flags.includes(key) && eq === -1) {
      flags.add(key);
    } else {
      throw new ConfigError(`unknown option --${key}`);
    }
  }
  return { network: parseNetworkName(options.get("network")), options, flags };
}

export type ReportMode = "cre" | "direct";

/** Default is real `cre workflow simulate`; `direct` is the clearly named fallback through the mock forwarder. */
export function reportMode(args: Args): ReportMode {
  const value = args.options.get("reports") ?? "cre";
  if (value !== "cre" && value !== "direct") throw new ConfigError(`--reports must be cre or direct (got ${value})`);
  return value;
}

/** Runs a script entry point, printing a one-line error and exiting non-zero on failure. */
export function main(run: () => Promise<void>): void {
  run().then(
    () => process.exit(0),
    (e: unknown) => {
      console.error(`error: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
      process.exit(1);
    },
  );
}
