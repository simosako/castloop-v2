import { showReservationSchema, validateId } from "../packages/shared/src/index";
import type { ShowControl, ShowReservation } from "../packages/shared/src/index";
import type { LifecycleReadEnv } from "./lifecycle-control";

export async function readShowReservation(env: LifecycleReadEnv, showId: string): Promise<{ value: ShowReservation; etag: string; size: number } | null> {
  const object = await env.CASTLOOP_BUCKET.get(`system/show-reservations/${validateId(showId, "show")}.json`);
  if (!object) return null;
  if (object.size < 1 || object.size > 16384) throw new Error("Show reservation is empty or oversized");
  const value = showReservationSchema.parse(await object.json<unknown>());
  if (value.show_id !== showId) throw new Error("Show reservation does not match its key");
  return { value, etag: object.etag, size: object.size };
}

export async function requireShowReservationReady(env: LifecycleReadEnv, control: ShowControl): Promise<void> {
  if (!control.reservation_id) return;
  const reservation = await readShowReservation(env, control.show_id);
  if (reservation?.value.reservation_id !== control.reservation_id) throw new Error("Show reservation is incomplete or belongs to another registration");
}
