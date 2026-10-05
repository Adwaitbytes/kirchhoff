"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { API_URL, DATA_SOURCE, createHttpClient, isApiError, type KirchhoffApi } from "@/lib/api/client";
import { FixtureWorld, createFixtureClient, isFixtureScenario, type FixtureScenario } from "@/lib/api/fixtures";

interface ApiContextValue {
  api: KirchhoffApi;
  /** Only set in fixtures mode; drives the dev controls. */
  fixtures: { world: FixtureWorld; scenario: FixtureScenario } | null;
}

const ApiContext = createContext<ApiContextValue | null>(null);

function readScenario(): FixtureScenario {
  if (typeof window === "undefined") return "live";
  const q = new URLSearchParams(window.location.search).get("scenario");
  if (isFixtureScenario(q)) return q;
  // A fresh load of an Incident Room has no fixture history, so open on the post-attack world.
  return window.location.pathname.startsWith("/app/incidents/") ? "breach" : "live";
}

function createContextValue(): ApiContextValue {
  if (DATA_SOURCE === "fixtures") {
    const scenario = readScenario();
    const world = new FixtureWorld(scenario);
    return { api: createFixtureClient(world), fixtures: { world, scenario } };
  }
  return { api: createHttpClient({ baseUrl: API_URL }), fixtures: null };
}

export function ApiProvider({ children }: { children: ReactNode }) {
  const [value] = useState(createContextValue);
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 15_000,
            refetchOnWindowFocus: false,
            retry: (count, err) => (isApiError(err) && (err.code === "NOT_FOUND" || err.code === "UNAUTHORIZED") ? false : count < 2),
          },
        },
      }),
  );

  useEffect(() => {
    const world = value.fixtures?.world;
    if (!world) return;
    world.start();
    return () => world.stop();
  }, [value]);

  return (
    <ApiContext.Provider value={value}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </ApiContext.Provider>
  );
}

export function useApi(): KirchhoffApi {
  const ctx = useContext(ApiContext);
  if (!ctx) throw new Error("useApi must be used inside <ApiProvider>");
  return ctx.api;
}

export function useFixtures(): ApiContextValue["fixtures"] {
  const ctx = useContext(ApiContext);
  if (!ctx) throw new Error("useFixtures must be used inside <ApiProvider>");
  return ctx.fixtures;
}
