import { readShowControl } from "./lifecycle-control";
import type { LifecycleReadEnv, ShowControlSnapshot } from "./lifecycle-control";
import { requireShowReservationReady } from "./show-reservation-record";

export async function readSettledShowControls(env: LifecycleReadEnv & { CASTLOOP_BUCKET: Pick<R2Bucket, "get" | "head" | "list"> }):
  Promise<ShowControlSnapshot[]> {
  const prefix = "system/show-publications/";
  const page = await env.CASTLOOP_BUCKET.list({ prefix, limit: 100 });
  if (page.truncated) throw new Error("Service change exceeds its bounded Show-control inspection budget");
  const controls: ShowControlSnapshot[] = [];
  for (const object of page.objects) {
    const showId = object.key.slice(prefix.length, -5);
    if (object.key !== `${prefix}${showId}.json`) throw new Error("Unknown Show-control key blocks service changes");
    const control = await readShowControl(env, showId);
    if (!control || control.value.owner || control.value.lifecycle === "deleting") {
      throw new Error("Service change requires settled Show owners; unknown uploads or publications are not expired");
    }
    await requireShowReservationReady(env, control.value);
    controls.push(control);
  }
  return controls.toSorted((left, right) => left.value.show_id < right.value.show_id ? -1 : left.value.show_id > right.value.show_id ? 1 : 0);
}
