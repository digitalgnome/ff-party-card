# Changelog

## 2.1.0
- New default font: DotGothic16, closer to the SNES-era Final Fantasy menus.
- Font picker in the editor with six pixel-font presets, each size-matched.
- `font_url` loads your own font file (.ttf / .woff / .woff2) or a stylesheet.
- No more smeared fake-bold on pixel fonts.

## 2.0.0
- Visual card editor: party settings, theme, advanced options, and a member list you can add to, reorder, and remove from.
- HP and MP can come from any sensor, with an "empty at" / "full at" range.
- Theme presets (Classic blue, FF7 deep blue, Crimson, Forest, Midnight, Moogle pink) plus per-color overrides, font, and size.
- Custom status effects from any entity (match a state, or above / below a number).
- Tap and hold actions per member (more-info by default).
- Configurable HP/MP labels, display maxes, and the text under each bar.
- v1 configs (`battery`, `steps`, `storage`) still work and are converted by the editor.

## 1.3.0
- `gil:` shows any sensor in the time bar.

## 1.2.0
- Time bar moved to the top by default (`footer_position: bottom` to move it back).

## 1.1.0
- `storage:` option for MP.

## 1.0.0
- First version: HP = battery, MP = steps, Regen / Sleep / Silence / Slow / KO statuses.
