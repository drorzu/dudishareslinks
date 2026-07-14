# DESIGN.md — sharelinks gallery

The aesthetic is **Parisian pixel art**: café warmth + 8/16-bit charm. Full-palette
color strategy with named Parisian roles. Two worlds: day (cream) and night (indigo).

## Color (OKLCH, tinted neutrals — never #000/#fff)

### Day (light)
| Role | Value | Use |
|---|---|---|
| Papier (bg) | `oklch(0.965 0.014 85)` | page background, warm cream paper |
| Papier-2 | `oklch(0.93 0.02 84)` | recessed panels, card face |
| Encre (ink) | `oklch(0.30 0.035 265)` | primary text |
| Ciel | `oklch(0.70 0.10 235)` | sky blue — primary accent |
| Laiton (brass) | `oklch(0.72 0.11 78)` | gold — chips, ornaments |
| Rouge | `oklch(0.57 0.17 25)` | awning red — sparing emphasis |
| Vert | `oklch(0.60 0.09 155)` | café-awning green — one theme accent |

### Night (dark) — Paris nuit
| Role | Value | Use |
|---|---|---|
| Nuit (bg) | `oklch(0.22 0.045 265)` | deep indigo sky |
| Nuit-2 | `oklch(0.27 0.045 265)` | card face |
| Craie (text) | `oklch(0.92 0.02 85)` | warm cream text |
| Ciel | `oklch(0.74 0.11 235)` | |
| Laiton (lit) | `oklch(0.80 0.13 82)` | lit windows, glow |
| Rouge | `oklch(0.64 0.17 25)` | |

Themes rotate through {Ciel, Laiton, Rouge, Vert} so each district reads distinct.

## Typography
- **Silkscreen** (Google) — pixel display. Site title, theme/district headers,
  chips, dates, footer. Uppercase, letter-spaced. Fallback: monospace.
- **Bricolage Grotesque** (Google) — content: report card titles, subtitle, body.
  Warm, characterful, not a reflex font. Fallback: system-ui.
- Scale: fluid `clamp()`, ≥1.25 steps. Pixel font stays small (chrome); grotesque
  carries readable content.

## Elevation / borders
- **Pixel borders**, never CSS `border-*` side stripes. Build the chunky frame with
  layered hard `box-shadow` steps (2px stacks) so edges read as pixels.
- Hover: crisp lift (translateY) with `ease-out-expo`, no bounce. Never animate layout.
- `image-rendering: pixelated` on all pixel illustrations.

## Components
- **Pixel Paris banner**: inline SVG scene (rooftops + Eiffel Tower + moon/sun),
  hand-placed rects in palette. Day = sun + cream; night = moon + lit windows.
- **Day/Night toggle**: pixel sun/moon button, flips `data-theme` on `<html>`,
  defaults to system. Delight, not chrome.
- **Search "ticket"**: pixel-framed input, marquee placeholder.
- **District section**: pixel awning-stripe header + pixel bullet + count token.
- **Postcard card**: pixel frame, grotesque title, Silkscreen date, tiny pixel
  corner ornament, themed accent per district. Grid: `repeat(auto-fit,minmax(260px,1fr))`.
- **Empty state**: small pixel café scene + charming line.
