#!/usr/bin/env bash
# The profile screens use open-source Material Symbols (Apache 2.0), the same family as the other
# icons in Assets/Icons. One icon per screen plus the app mark; tiles are text only.
#     bash tools/assets/fetch_icons.sh      -> Assets/Icons/profile/<name>.png (256 px, white on transparent)
set -euo pipefail
OUT="$(cd "$(dirname "$0")/../.." && pwd)/Assets/Icons/profile"
TMP="$(mktemp -d)"
mkdir -p "$OUT"
for pair in "allergies:no_food" "religious:self_improvement" "diet:eco" "logo:restaurant_menu" "keyboard:keyboard" "mic:mic" "mic_off:mic_off" "speaker:volume_up" "speaker_off:volume_off" "edit:edit"; do
  name="${pair%%:*}"; sym="${pair##*:}"
  curl -fsSL -o "$TMP/$sym.svg" "https://fonts.gstatic.com/s/i/short-term/release/materialsymbolsrounded/$sym/default/48px.svg"
  qlmanage -t -s 256 -o "$TMP" "$TMP/$sym.svg" >/dev/null 2>&1
  python3 - "$TMP/$sym.svg.png" "$OUT/$name.png" <<'PY'
import sys
from PIL import Image
# qlmanage renders the black glyph on an opaque white background: darkness becomes the alpha, the glyph white.
im = Image.open(sys.argv[1]).convert("RGB")
px = im.load()
out = Image.new("RGBA", im.size, (255, 255, 255, 0))
op = out.load()
for y in range(im.height):
    for x in range(im.width):
        r, g, b = px[x, y]
        op[x, y] = (255, 255, 255, 255 - (r + g + b) // 3)
# Material glyphs sit in a wide transparent frame: crop to the glyph and pad 8 % so it fills its slot in the Lens.
bbox = out.getchannel("A").getbbox()
if bbox:
    out = out.crop(bbox)
side = max(out.size)
pad = int(side * 0.08)
framed = Image.new("RGBA", (side + 2 * pad, side + 2 * pad), (255, 255, 255, 0))
framed.paste(out, (pad + (side - out.width) // 2, pad + (side - out.height) // 2))
framed.resize((256, 256), Image.LANCZOS).save(sys.argv[2])
PY
  echo "$name <- $sym"
done
rm -rf "$TMP"
