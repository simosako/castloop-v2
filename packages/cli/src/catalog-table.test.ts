import { expect, test } from "bun:test";
import { formatEpisodeTable, formatShowTable } from "./catalog-table";

test("shared catalog tables preserve TSV columns and escape controls without conflating null and empty text", () => {
  expect(formatShowTable([{ show_id: "show", lifecycle: "published", unfinished_operation: true,
    title: '番組\t"title"\n', feed_url: null }])).toEqual([
    "SHOW_ID\tSTATE\tUNFINISHED\tTITLE\tFEED_URL", 'show\tpublished\ttrue\t番組\\t\\"title\\"\\n\t(unavailable)',
  ]);
  expect(formatEpisodeTable([{ episode_id: "first", lifecycle: "draft", published_at: null, title: "" }])).toEqual([
    "EPISODE_ID\tSTATE\tPUBLISHED_AT\tTITLE", "first\tdraft\t(unavailable)\t",
  ]);
  expect(formatShowTable([])).toEqual(["SHOW_ID\tSTATE\tUNFINISHED\tTITLE\tFEED_URL"]);
});
