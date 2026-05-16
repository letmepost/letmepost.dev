"""Render both light and dark logo variants — single SVG with text already
converted to paths so there's no font dependency at runtime. Output goes to
apps/web/public/ so both the landing and the docs site can reference the
same canonical URL."""
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from pathlib import Path

FONT = "/Users/rosekamallove/dev/side-projects/letmepost.dev/node_modules/.pnpm/@fontsource+instrument-serif@5.2.8/node_modules/@fontsource/instrument-serif/files/instrument-serif-latin-400-italic.woff2"
PUBLIC = Path("/Users/rosekamallove/dev/side-projects/letmepost.dev/apps/web/public")

TEXT_BLACK = "letmepost"
TEXT_GREEN = ".dev"
FONT_SIZE_PX = 26
TEXT_X = 44
TEXT_BASELINE_Y = 26

# Light variant — paper background.
LIGHT = {
    "icon_fill": "#2D7652",
    "icon_negative": "#FFFFFF",
    "text_fill": "#171411",
    "accent_fill": "#2D7652",
}
# Dark variant — for the docs dark mode + any dark surface.
DARK = {
    "icon_fill": "#4DBE85",
    "icon_negative": "#0D1117",
    "text_fill": "#F2EDE3",
    "accent_fill": "#4DBE85",
}

def text_paths(font, glyph_set, units_per_em, cmap, s, x, y, size, fill):
    scale = size / units_per_em
    out = []
    cursor_x = x
    for ch in s:
        cp = ord(ch)
        if cp not in cmap:
            cursor_x += size * 0.4
            continue
        gname = cmap[cp]
        glyph = glyph_set[gname]
        pen = SVGPathPen(glyph_set)
        glyph.draw(pen)
        d = pen.getCommands()
        if d:
            out.append(
                f'<path d="{d}" fill="{fill}" '
                f'transform="translate({cursor_x:.3f} {y}) scale({scale:.5f} -{scale:.5f})"/>'
            )
        cursor_x += glyph.width * scale
    return "\n  ".join(out), cursor_x

font = TTFont(FONT)
units = font["head"].unitsPerEm
cmap = font.getBestCmap()
glyph_set = font.getGlyphSet()

def render(variant, filename):
    black_paths, after_black = text_paths(
        font, glyph_set, units, cmap, TEXT_BLACK, TEXT_X, TEXT_BASELINE_Y, FONT_SIZE_PX, variant["text_fill"]
    )
    green_paths, after_green = text_paths(
        font, glyph_set, units, cmap, TEXT_GREEN, after_black, TEXT_BASELINE_Y, FONT_SIZE_PX, variant["accent_fill"]
    )
    width = int(after_green + 8)
    height = 36
    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" height="{height}" width="{width}">
  <!-- Stamp: green circle + rotated negative-space square. Matches Logo.astro. -->
  <circle cx="16" cy="16" r="15" fill="{variant["icon_fill"]}"/>
  <rect x="9.5" y="9.5" width="13" height="13" fill="{variant["icon_negative"]}" transform="rotate(16 16 16)"/>

  <!-- Wordmark: Instrument Serif italic, baked to paths (no font dependency). -->
  {black_paths}
  {green_paths}
</svg>
'''
    (PUBLIC / filename).write_text(svg)
    print(f"wrote {filename} — {width}x{height}, {len(svg)} bytes")

render(LIGHT, "logo.svg")
render(DARK, "logo-dark.svg")
