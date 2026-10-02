import { parseShowControl, showRegistrationRequestSchema, showRegistrationResponseSchema, showReservationSchema } from "../packages/shared/src/index";
import type { ShowControl, ShowRegistrationRequest, ShowRegistrationResponse } from "../packages/shared/src/index";
import { readShowControl } from "./lifecycle-control";
import type { LifecycleControlEnv, LifecycleReadEnv } from "./lifecycle-control";
import { readShowReservation } from "./show-reservation-record";

export type ShowRegistrationEnv = LifecycleControlEnv & { CASTLOOP_BUCKET: Pick<R2Bucket, "list"> };

function initialControl(input: ShowRegistrationRequest): ShowControl {
  return parseShowControl({ schema_version: 2, show_id: input.show_id, reservation_id: input.reservation_id,
    lifecycle: "draft", generation: 0, feed_generation: 0 });
}

async function requireUnusedShowPaths(env: ShowRegistrationEnv, showId: string): Promise<void> {
  for (const prefix of [`system/shows/${showId}/`, `system/episode-lifecycle/${showId}/`, `public/podcasts/${showId}/`,
    `public/episodes/${showId}/`, `staging/shows/${showId}/`, `staging/episodes/${showId}/`]) {
    const page = await env.CASTLOOP_BUCKET.list({ prefix, limit: 1 });
    if (page.objects.length || page.truncated) throw new Error("Show ID has existing data and cannot be registered");
  }
}

export async function reserveM6Show(env: ShowRegistrationEnv, input: ShowRegistrationRequest): Promise<ShowRegistrationResponse> {
  const request = showRegistrationRequestSchema.parse(input);
  if (request.action !== "reserve") throw new Error("Show registration requires an explicit reserve action");
  let control = await readShowControl(env, request.show_id);
  let reservation = await readShowReservation(env, request.show_id);
  if (!control) {
    if (reservation) throw new Error("Existing reservation without Show control requires recovery, not registration");
    await requireUnusedShowPaths(env, request.show_id);
    const written = await env.CASTLOOP_BUCKET.put(`system/show-publications/${request.show_id}.json`, JSON.stringify(initialControl(request)),
      { onlyIf: new Headers({ "If-None-Match": "*" }) });
    control = await readShowControl(env, request.show_id);
    if (!written && control?.value.reservation_id !== request.reservation_id) throw new Error("Another registration already owns this Show ID");
  }
  if (!control || control.value.reservation_id !== request.reservation_id || ["deleting", "deleted"].includes(control.value.lifecycle)) {
    throw new Error("Existing or deleted Show ID cannot be registered again");
  }
  reservation = await readShowReservation(env, request.show_id);
  if (!reservation) {
    if (JSON.stringify(control.value) !== JSON.stringify(initialControl(request))) throw new Error("Missing reservation on an advanced Show requires recovery");
    await requireUnusedShowPaths(env, request.show_id);
    const current = await readShowControl(env, request.show_id);
    if (!current || current.etag !== control.etag || JSON.stringify(current.value) !== JSON.stringify(initialControl(request))) {
      throw new Error("Show registration changed before its reservation was completed");
    }
    const value = showReservationSchema.parse({ show_id: request.show_id, reservation_id: request.reservation_id });
    await env.CASTLOOP_BUCKET.put(`system/show-reservations/${request.show_id}.json`, JSON.stringify(value),
      { onlyIf: new Headers({ "If-None-Match": "*" }) });
    reservation = await readShowReservation(env, request.show_id);
  }
  const current = await readShowControl(env, request.show_id);
  if (reservation?.value.reservation_id !== request.reservation_id || current?.value.reservation_id !== request.reservation_id ||
    ["deleting", "deleted"].includes(current.value.lifecycle)) throw new Error("Show registration did not retain matching control and reservation");
  return showRegistrationResponseSchema.parse({ schema_version: 1, service_id: request.service_id, show_id: request.show_id,
    reservation_id: request.reservation_id, result: "reserved", control_ready: true });
}

export async function inspectShowRegistration(env: LifecycleReadEnv, input: ShowRegistrationRequest): Promise<ShowRegistrationResponse> {
  const request = showRegistrationRequestSchema.parse(input);
  if (request.action !== "status") throw new Error("Show inspection requires a status action");
  const control = await readShowControl(env, request.show_id);
  const reservation = await readShowReservation(env, request.show_id);
  const currentControl = await env.CASTLOOP_BUCKET.head(`system/show-publications/${request.show_id}.json`);
  const currentReservation = await env.CASTLOOP_BUCKET.head(`system/show-reservations/${request.show_id}.json`);
  if (currentControl?.etag !== control?.etag || currentReservation?.etag !== reservation?.etag || currentReservation?.size !== reservation?.size) {
    throw new Error("Show registration changed during read-only inspection");
  }
  const ownsControl = control?.value.reservation_id === request.reservation_id;
  const ownsReservation = reservation?.value.reservation_id === request.reservation_id;
  const state = !control && !reservation ? "missing" : ownsControl && ownsReservation ? "reserved" :
    ownsControl && !reservation && JSON.stringify(control.value) === JSON.stringify(initialControl(request)) ? "initializing" : "occupied";
  return showRegistrationResponseSchema.parse({ schema_version: 1, service_id: request.service_id, show_id: request.show_id,
    reservation_id: request.reservation_id, result: "status", state, lifecycle: control?.value.lifecycle ?? null,
    generation: control?.value.generation ?? null, authorizes_registration: false });
}
