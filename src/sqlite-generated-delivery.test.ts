import { expect, test } from "bun:test";
import { directPublicationFixture } from "./test-support/direct-publication";
import { serveCachedLifecycleAsset } from "./lifecycle-cache";
import { serveCachedSitePage } from "./site-cache";

test("Feed validators reflect Episode unpublish and restore without relying on modification dates", async () => {
  const f = await directPublicationFixture();
  try {
    await f.publish(f.show()); await f.publish(f.episode());
    const path = "/podcasts/daily/feed.xml";
    const fetch = (headers: HeadersInit = {}) => {
      const decision = f.content.delivery(path);
      if (decision.status !== 200) throw new Error("Expected a published Feed");
      return serveCachedLifecycleAsset(new Request(`https://cache.invalid${path}`, { headers }), {
        CASTLOOP_BUCKET: {} as R2Bucket,
        renderFeed: () => f.content.renderFeed("daily", f.config.public_base_url),
      }, decision.cache_props);
    };
    const first = await fetch(), etag = first.headers.get("ETag")!;
    expect(first.headers.has("Last-Modified")).toBe(false);
    expect(await first.text()).toContain("saved-first");
    expect((await fetch({ "If-None-Match": etag })).status).toBe(304);
    await f.queue.publish(f.action("unpublish", "first"));
    const hidden = await fetch({ "If-None-Match": etag, "If-Modified-Since": "Thu, 01 Jan 2099 00:00:00 GMT" });
    expect(hidden.status).toBe(200);
    expect(await hidden.text()).not.toContain("saved-first");
    expect((await fetch({ "If-Modified-Since": "Thu, 01 Jan 2099 00:00:00 GMT" })).status).toBe(200);
    expect((await fetch({ Range: "bytes=0-3", "If-Range": "Thu, 01 Jan 2099 00:00:00 GMT" })).status).toBe(200);
    await f.queue.publish(f.action("restore", "first"));
    const restored = await fetch({ "If-None-Match": hidden.headers.get("ETag")! });
    expect(restored.status).toBe(200);
    expect(await restored.text()).toContain("saved-first");
  } finally { f.close(); }
});

test("Show edits change Episode page ETags and date-only conditions do not hide the edits", async () => {
  const f = await directPublicationFixture();
  try {
    await f.publish(f.show()); await f.publish(f.episode());
    const page = { kind: "episode" as const, showId: "daily", siteId: f.content.siteIds.get("daily", "first")! };
    const fetch = (headers: HeadersInit = {}) => {
      const decision = f.content.siteDelivery(page);
      if (decision.status !== 200) throw new Error("Expected a published page");
      return serveCachedSitePage(new Request(`https://cache.invalid/podcasts/daily/${page.siteId}/`, { headers }),
        () => f.content.renderSitePage(page, f.config.public_base_url), decision.props);
    };
    const first = await fetch(), etag = first.headers.get("ETag")!;
    expect(first.headers.has("Last-Modified")).toBe(false);
    expect((await fetch({ "If-None-Match": etag })).status).toBe(304);
    const update = f.show(); update.metadata.title = "Updated Show";
    await f.publish(update);
    const changed = await fetch({ "If-None-Match": etag });
    expect(changed.status).toBe(200);
    expect(await changed.text()).toContain("Updated Show");
    expect((await fetch({ "If-Modified-Since": "Thu, 01 Jan 2099 00:00:00 GMT" })).status).toBe(200);
    expect((await fetch({ "If-Unmodified-Since": "Thu, 01 Jan 1970 00:00:00 GMT" })).status).toBe(200);
    expect((await fetch({ "If-Match": etag })).status).toBe(412);
  } finally { f.close(); }
});
