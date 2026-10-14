import type { RssAssetTransport } from "../rss-import-download";

export const RSS_IMPORT_AUDIO = Buffer.concat(Array.from({ length: 50 }, () => Buffer.concat([Buffer.from([255, 251, 144, 100]), Buffer.alloc(413)])));
export const RSS_IMPORT_SOURCE = `<rss version="2.0" xmlns:i="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel>
  <title>Imported</title><description>Description</description><language>ja</language><link>https://site.example/podcast</link>
  <i:author>Author</i:author><i:owner><i:name>Owner</i:name><i:email>owner@example.com</i:email></i:owner>
  <i:category text="Technology"/><i:explicit>false</i:explicit><i:image href="https://media.example/cover"/>
  <item><title>First</title><description>Description</description><guid isPermaLink="false">old:123</guid>
  <pubDate>Wed, 01 Apr 2020 03:00:00 GMT</pubDate><enclosure url="https://media.example/audio" length="20850"/></item></channel></rss>`;

export function rssImportTransport(failAudio = false, source = RSS_IMPORT_SOURCE): { effects: RssAssetTransport; requests: string[] } {
  const requests: string[] = [];
  return { requests, effects: { async resolve() { return [{ address: "1.1.1.1", family: 4 }]; },
    async request(url) {
      requests.push(url.pathname);
      const bytes = url.pathname === "/feed" ? Buffer.from(source) : url.pathname === "/cover" ? Buffer.from([255, 216, 255, 0]) : RSS_IMPORT_AUDIO;
      return { status: 200, headers: {}, body: (async function* () {
        if (failAudio && url.pathname === "/audio") { yield bytes.subarray(0, 4); throw new Error("Connection lost"); }
        yield bytes;
      })(), close() {} };
    } } };
}
