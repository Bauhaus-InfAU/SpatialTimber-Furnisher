// The dataset written by tools/export_composer_archive.py (format furnisher-composer-archive@1).
import type { ApartmentRequest, ApartmentResult, RoomInput } from "@engine/apartment";
import type { Placed, XY } from "./composerDraw";

export type ArchiveIndexRow = {
  id: string;
  chunk: string;
  aptType: string;
  /** the drawing holds an Open kitchen */
  open: boolean;
  /** the request sends subtype "Open kitchen" (plan2 counts the kitchen as open) */
  openSent: boolean;
  briefs: string[];
  storedScore: number | null;
  nRooms: number;
  area: number;
  /** the studio's request equals the old furn request (the stored score is of this very request) */
  sameAsFurn: boolean;
  /** false: the studio's measure path would not furnish it (the archive's furn2 request is used) */
  studio?: boolean;
  studioWhy?: string;
};

export type ArchiveIndex = {
  format: string;
  created: string;
  request_path: string;
  stored_path: string | null;
  counts: Record<string, number>;
  n: number;
  layouts: ArchiveIndexRow[];
};

export type StoredRoom = {
  char: string;
  type: string;
  score: number | null;
  complete?: boolean;
  area_m2?: number;
  steps?: [string, number][];
  missing_steps?: string[];
};

export type ArchiveLayout = {
  id: string;
  pl_id: string;
  hash: string;
  drawn_hash: string;
  shape_id: string;
  sym: string;
  briefs: { brief: string; record: string | null }[];
  aptType: string;
  W: number;
  H: number;
  request: Omit<ApartmentRequest, "rooms"> & { rooms: (RoomInput & { area?: number | null })[] };
  request_sha256: string;
  request_path: string;
  archive_furn2_sha256: string;
  furn_request_sha256: string;
  /** room characters of the request's rooms, in request order */
  request_chars: string[];
  door_edges: string[];
  stored: { version: string; score: number; complete: boolean; error: string | null; rooms: StoredRoom[]; request_sha256: string } | null;
  draw: Placed & { facade: XY[][]; grid: string[]; legend: Record<string, string> };
};

export type WallMode = "parity" | "inset";

/** The apartment's furnishing as the app shows it: the engine's result plus the composer's score rule. */
export type Furnished = {
  key: string;
  result: ApartmentResult;
  /** area-weighted apartment score as the composer computes it (E10 furnish.score_row / furn2.report_of) */
  score: number;
  complete: boolean;
  ms: number;
  /** the request actually sent (the inset polygons when WallMode is "inset") */
  request: ApartmentRequest;
};

/** The composer's apartment score of an engine result (furn2.report_of: rooms zipped with the request's rooms,
 *  score or 0, weighted by the request's `area`, rounded to 2 decimals; complete = no error and every step >= 1 option). */
export function composerScore(req: ApartmentLayoutRequest, result: ApartmentResult): { score: number; complete: boolean } {
  let wsum = 0;
  let asum = 0;
  let complete = true;
  req.rooms.forEach((r, i) => {
    const rm = result.rooms[i];
    if (!rm) return;
    const area = r.area ?? 0;
    const sc = rm.score ?? 0;
    const ok = !rm.error && rm.steps.length > 0 && rm.steps.every((s) => s.optionCount >= 1);
    complete = complete && ok;
    wsum += sc * area;
    asum += area;
  });
  return { score: asum ? Math.round((wsum / asum) * 100) / 100 : 0, complete };
}

export type ApartmentLayoutRequest = ArchiveLayout["request"];
