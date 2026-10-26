import { expect, test } from "bun:test";
import { formatSiteDescription } from "./site-description";

test("descriptions preserve paragraphs and breaks while producing a plain excerpt", () => {
  expect(formatSiteDescription('<p class="x" onclick="bad()">最初の段落</p>\n<p>次の段落<br>続き &amp; 補足</p>')).toEqual({
    excerpt: "最初の段落 次の段落 続き & 補足", html: "<p>最初の段落</p><p>次の段落<br>続き &amp; 補足</p>",
  });
  for (const br of ["<br>", "<br/>", "<BR />"]) {
    expect(formatSiteDescription(`<p>A${br}B<p>C`)).toEqual({ excerpt: "A B C", html: "<p>A<br>B</p><p>C</p>" });
  }
  expect(formatSiteDescription("first\r\nsecond\nthird")).toEqual({ excerpt: "first second third", html: "<p>first<br>second<br>third</p>" });
  expect(formatSiteDescription("<div>one</div><ul><li>two<li>three</ul>four")).toEqual({
    excerpt: "one two three four", html: "<p>one<br>two<br>three<br>four</p>",
  });
});

test("entities decode once, independent of parser text chunks, without becoming markup", () => {
  expect(formatSiteDescription("&lt;p&gt;&amp;lt;br&amp;gt; &nbsp; &#x1f600; &#38; &copy;")).toEqual({
    excerpt: "<p>&lt;br&gt; 😀 & ©", html: "<p>&lt;p&gt;&amp;lt;br&amp;gt;   😀 &amp; ©</p>",
  });
  expect(formatSiteDescription('<p title="a > b">A <strong>B</strong><a href="javascript:bad()">C</a></p>')).toEqual({
    excerpt: "A BC", html: "<p>A BC</p>",
  });
});

test("excerpt limits count decoded Unicode code points rather than tags or UTF-16 units", () => {
  const text = "日😀".repeat(80);
  expect(formatSiteDescription(`<p>${text}</p>`).excerpt).toBe(text);
  expect(formatSiteDescription(`<p>${text}尾</p>`).excerpt).toBe(text + "…");
  expect(formatSiteDescription("&amp;".repeat(161)).excerpt).toBe("&".repeat(160) + "…");
});

test("only fixed paragraphs and breaks survive untrusted markup, never attributes or non-body text", () => {
  const source = '<!doctype html><!-- secret --><head><title>hidden</title><style>hidden</style></head>' +
    '<p onmouseover="hidden">safe</p><script>hidden <p>hidden</script>' +
    '<form><div>hidden<input value="hidden"><button>hidden</button></div></form>' +
    '<svg><title>hidden</title><foreignObject><p>hidden</p></foreignObject></svg>' +
    '<math><mtext>hidden</mtext></math><iframe>hidden</iframe><object>hidden</object>' +
    '<template><p>hidden</p></template><audio>hidden</audio><video>hidden</video>' +
    '<img src="hidden" onerror="hidden"><p>after &lt;script&gt;</p>';
  expect(formatSiteDescription(source)).toEqual({ excerpt: "safe after <script>", html: "<p>safe</p><p>after &lt;script&gt;</p>" });
  expect(formatSiteDescription("<script>hidden")).toEqual({ excerpt: "", html: "" });
  expect(formatSiteDescription("<!-- comment -->")).toEqual({ excerpt: "", html: "" });
  expect(formatSiteDescription("<p></p>")).toEqual({ excerpt: "", html: "" });
});

test("visible HTTP URLs become links only in the full description, keeping surrounding punctuation", () => {
  const source = "資料 https://example.com/docs?q=1&amp;lang=ja。 (http://example.org/a_(b)).\nHTTPS://EXAMPLE.NET/path!";
  expect(formatSiteDescription(source)).toEqual({
    excerpt: "資料 https://example.com/docs?q=1&lang=ja。 (http://example.org/a_(b)). HTTPS://EXAMPLE.NET/path!",
    html: '<p>資料 <a href="https://example.com/docs?q=1&amp;lang=ja">https://example.com/docs?q=1&amp;lang=ja</a>。 ' +
      '(<a href="http://example.org/a_(b)">http://example.org/a_(b)</a>).<br>' +
      '<a href="https://example.net/path">HTTPS://EXAMPLE.NET/path</a>!</p>',
  });
  expect(formatSiteDescription("https://example.com/a&#x2f;b").html).toBe(
    '<p><a href="https://example.com/a/b">https://example.com/a/b</a></p>');
  expect(formatSiteDescription("https://example.com/&lt;script&gt;").html).toBe(
    '<p><a href="https://example.com/">https://example.com/</a>&lt;script&gt;</p>');
});

test("existing HTTP links retain their text and safe destinations, never source attributes", () => {
  const source = '<p>読む: <a href="https://example.com/docs?a=1&amp;b=2" target="_blank" onclick="bad()" style="color:red">' +
    '<strong>資料 &amp; 補足</strong><br>続き</a> <a href="http://example.org">別の資料</a></p>';
  expect(formatSiteDescription(source)).toEqual({
    excerpt: "読む: 資料 & 補足 続き 別の資料",
    html: '<p>読む: <a href="https://example.com/docs?a=1&amp;b=2">資料 &amp; 補足</a><br>' +
      '<a href="https://example.com/docs?a=1&amp;b=2">続き</a> <a href="http://example.org/">別の資料</a></p>',
  });
  expect(formatSiteDescription('<a href="https://example.com/">https://other.example/</a>').html).toBe(
    '<p><a href="https://example.com/">https://other.example/</a></p>');
  expect(formatSiteDescription('<a href="https://example.com/?q=&quot;test&quot;">&lt;b&gt;</a>').html).toBe(
    '<p><a href="https://example.com/?q=%22test%22">&lt;b&gt;</a></p>');
});

test("unsafe or unsupported link destinations remain text without executable or relative links", () => {
  for (const href of ["javascript:alert(1)", "jav&#x09;ascript:alert(1)", "data:text/html,secret", "ftp://example.com/",
    "//example.com/", "/admin/", "#section", "https://user:pass@example.com/", "https://example.com\\@evil.example/",
    "https://exa&#10;mple.com/", "http://", "https://[invalid", ""]) {
    expect(formatSiteDescription(`<a href="${href}">資料</a>`)).toEqual({ excerpt: "資料", html: "<p>資料</p>" });
  }
  expect(formatSiteDescription("https://user:pass@example.com/ https://[invalid").html).not.toContain("<a");
  expect(formatSiteDescription('<script><a href="https://example.com">hidden</a></script>').html).toBe("");
});
