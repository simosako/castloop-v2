# Show website

castloop's built-in website can publish a show introduction, an episode list, and a page for each episode. Visitors can play audio from these pages.

Run the following commands in the service workspace.

## Use the built-in website

Specify `--site-mode builtin` when creating a show:

```sh
castloop create-show my-show --site-mode builtin
```

Enter the show information in `my-show/show.toml` and prepare a cover image. Then [preview and publish](publishing.md).

After publication, append `/podcasts/my-show/` to the `public_base_url` in `castloop.toml` and open it in a browser.

| Page | Example URL |
| --- | --- |
| Show home and episode list | `https://podcasts.example.com/podcasts/my-show/` |
| Second page of the list | `https://podcasts.example.com/podcasts/my-show/page/2/` |
| Individual episode page | `https://podcasts.example.com/podcasts/my-show/db0a48404cdf5c53/` |
| RSS feed | `https://podcasts.example.com/podcasts/my-show/feed.xml` |

The list shows 20 episodes per page, newest first. Visitors can open an episode page from its title or the 「全文を読む」 (“Read more”) link. The episode page URL is assigned automatically and remains the same after content or audio updates. The built-in site's navigation labels are in Japanese.

## Change the appearance

### 1. Prepare CSS

Create `site.css` in `my-show/`. You can copy and edit the [CSS example](../examples/show-site.css).

For example, set colors and width as follows:

```css
:root {
  --cl-accent: #2563eb;
  --cl-background: #f8fafc;
  --cl-text: #0f172a;
  --cl-content-width: 60rem;
}
```

### 2. Specify the CSS file

Set the following in `my-show/show.toml`:

```toml
site_mode = "builtin"
site_css_path = "site.css"
```

Save the CSS as UTF-8 and keep it at or below 64 KiB.

### 3. Publish and check the display

Run a preview and review it. Replace `REVIEWED_HASH` with the resulting `input_fingerprint`, then publish:

```sh
castloop preview-show my-show --remote --json
castloop publish-show my-show --expect-preview REVIEWED_HASH --json
```

After publication, check the list and episode pages, audio player, and links.

To restore the default appearance, remove the `site_css_path` line and publish using the same procedure.

### Common CSS selectors and variables

| Area | CSS variables or classes |
| --- | --- |
| Colors | `--cl-accent`, `--cl-background`, `--cl-text`, `--cl-muted` |
| Width and rounded corners | `--cl-content-width`, `--cl-radius` |
| Page | `.cl-site`, `.cl-page-list`, `.cl-page-episode` |
| Header | `.cl-header`, `.cl-brand`, `.cl-subscribe` |
| Show introduction | `.cl-show`, `.cl-cover`, `.cl-author`, `.cl-description` |
| Episodes | `.cl-episode-list`, `.cl-episode`, `.cl-episode-title`, `.cl-episode-date` |
| Audio player and link | `.cl-player`, `.cl-audio-link` |
| Description and full-text link | `.cl-description-full`, `.cl-description-link`, `.cl-read-more` |
| Pagination | `.cl-pagination` |

## Publication date time zone

To display dates in Japan time, add the following to `show.toml`:

```toml
site_timezone = "Asia/Tokyo"
```

Preview and publish the show information. Dates on the list and episode pages will use Japan time. For example, `2025-12-16T22:00:00Z` displays as `2025-12-17 (UTC+09:00)`.

The default display is UTC. You can specify an IANA time zone such as `America/New_York` for another region.

Set the time zone for entering schedules separately in the [administrator settings](scheduling.md#optional-administrator-settings).

## Use an external website

To use your own website as the show's destination, specify its URL when creating the show:

```sh
castloop create-show my-show --site-mode external --site-url https://your-site.example/podcast
```

To switch an existing show to an external website, set its site configuration in `show.toml` as follows. Remove `site_css_path` and `site_timezone` if they are set.

```toml
site_mode = "external"
site_url = "https://your-site.example/podcast"
```

Preview and publish the change to use the specified URL as the RSS link. If you switch from the built-in site, castloop stops serving the show pages.

To return to the built-in site, change `site_mode` to `"builtin"`, remove the `site_url` line, and publish.

You can also choose this site configuration before publishing a show imported from RSS. See [RSS import](rss_migration.md).
