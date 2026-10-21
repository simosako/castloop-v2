import { sqlitePublicationRuntimeSchema } from "../packages/shared/src/sqlite-publication";
import { sqliteRegistrationSchema } from "../packages/shared/src/sqlite-service-api";
import { parsePublicAssetPath } from "../packages/shared/src/public-assets";

export function sqliteShowObjectName(serviceId: string, showId: string): string {
  sqlitePublicationRuntimeSchema.shape.service_id.parse(serviceId);
  sqliteRegistrationSchema.shape.show_id.parse(showId);
  return `show/${serviceId}/${showId}`;
}

export function sqliteRequestObjectName(request: Request, serviceId: string): string {
  sqlitePublicationRuntimeSchema.shape.service_id.parse(serviceId);
  const path = new URL(request.url).pathname;
  const showId = path.startsWith("/admin/") ? request.headers.get("X-Castloop-Show-Id") : parsePublicAssetPath(path)?.showId;
  if (showId === "") throw new Error("Empty Show scope");
  return showId ? sqliteShowObjectName(serviceId, showId) : `service/${serviceId}`;
}
