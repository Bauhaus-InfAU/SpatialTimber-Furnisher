// Furnishes one composer apartment off the UI thread with the engine's apartment-level entry point
// (`furnishApartment`, the same code the CLI runs for the composer), default options = the CLI's.
import { furnishApartment } from "@engine/apartment";
import type { ApartmentRequest } from "@engine/apartment";

// The engine logs `[placer] ...` debug lines; thousands of them per apartment slow the worker down.
console.log = () => {};
console.debug = () => {};
console.info = () => {};

export type FurnishJob = { key: string; request: ApartmentRequest };
export type FurnishReply = { key: string; ok: true; result: ReturnType<typeof furnishApartment>; ms: number } | { key: string; ok: false; error: string };

self.onmessage = (ev: MessageEvent<FurnishJob>) => {
  const { key, request } = ev.data;
  const t0 = performance.now();
  try {
    const result = furnishApartment(request);
    (self as unknown as Worker).postMessage({ key, ok: true, result, ms: Math.round(performance.now() - t0) } satisfies FurnishReply);
  } catch (err) {
    (self as unknown as Worker).postMessage({ key, ok: false, error: err instanceof Error ? err.message : String(err) } satisfies FurnishReply);
  }
};
