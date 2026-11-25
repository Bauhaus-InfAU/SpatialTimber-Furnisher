// ─── Furnisher core ─────────────────────────────────────────────────────────
//
// Bridge between the CLI callers (cli.ts, batch.ts) and the furnisher engine.
// The apartment-level logic lives in the engine (engine/apartment.ts,
// `furnishApartment`) so the app runs exactly the same code; this module only
// keeps the CLI's names for it.
//
// NOTE: the engine emits many `[placer] ...` debug lines via console.log at
// runtime. Callers should silence console.log/debug/info before invoking
// processRequest if stdout is their JSON channel.

import { furnishApartment, apartmentSummaryOf } from "../../../furnisher-engine/src/engine/apartment";
import type { ApartmentRequest, ApartmentResult } from "../../../furnisher-engine/src/engine/apartment";

export type {
  ApartmentRequest as Request, RoomInput, StepScoreOut, DoorOut, StepOut, RoomOut, VariantGroup, FallbackOut,
} from "../../../furnisher-engine/src/engine/apartment";

export function processRequest(req: ApartmentRequest): ApartmentResult {
  return furnishApartment(req);
}

/** The apartment's score and "every room furnished" for a set of room answers (the engine's apartmentSummaryOf). */
export const apartmentOf = apartmentSummaryOf;
