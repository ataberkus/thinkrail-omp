// Type contract for the build-time-generated engine worker-host module (`src/engine-worker-host.generated.ts`),
// which `bun run build:binary` writes before compilation and deletes afterward. This committed declaration
// keeps `compiled-entry.ts` typecheckable while the generated source is absent.

/** Declares this executable as the engine's worker host, so engine workers re-enter it with a selector. */
export declare function declareEngineWorkerHost(): void;

/** Whether an argv value is one of the engine's hidden worker selectors. */
export declare function isEngineWorkerSelector(value: string | undefined): value is string;

/** Runs the engine's own entry, which dispatches the selector in `process.argv`. */
export declare function runEngineWorker(): Promise<void>;
