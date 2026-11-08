#!/usr/bin/env bash
# Pre-rendered speech for the Lens (there is no text-to-speech API on SPECS in Lens Studio 5.23: the old
# TextToSpeechModule is deprecated). Fixed prompts are rendered once here with macOS `say` and bundled as
# MP3; the Lens plays them with an AudioComponent. Re-run after changing a line. Voice: Samantha (en_US).
set -euo pipefail
OUT="$(cd "$(dirname "$0")/../.." && pwd)/Assets/Audio/Speech"
VOICE="${VOICE:-Samantha}"
RATE="${RATE:-178}"
mkdir -p "$OUT"
line() {  # name "text"
  local tmp; tmp="$(mktemp -t al).aiff"
  say -v "$VOICE" -r "$RATE" -o "$tmp" "$2"
  # MP3 at 48 kbit/s mono keeps the whole prompt set under ~300 KB (a Lens package is capped at 8 MB).
  ffmpeg -loglevel error -y -i "$tmp" -ac 1 -ar 22050 -b:a 48k "$OUT/$1.mp3"
  rm -f "$tmp"
  printf "%-18s %6s KB  %s\n" "$1" "$(du -k "$OUT/$1.mp3" | cut -f1)" "$2"
}
line welcome        "Welcome to Allergy Specs."
line step_allergies "Step one. Any food allergies? Say them, pinch them, or say more for others."
line more           "Which other allergies? Just say them."
line step_religious "Step two. Anything you avoid for religious or cultural reasons? Beef, pork, or alcohol."
line step_diet      "Step three. Any diet? Vegetarian, vegan, low sugar, or no trans fat."
line saved          "Profile saved. Now look at a menu."
line reopened       "Your profile. Change anything, or say done."
line heard_nothing  "Sorry, I didn't catch that. Say it again, or pinch."
line menu_found     "Menu recognised. Point at a dish to check it. Pinch for details."
line contains       "This dish has something from your profile."
line likely_fine    "Likely fine. Confirm with the restaurant."
line safe           "Looks fine for you."
line unknown        "Ingredients not published. Ask the restaurant."
line muted          "Voice off. Say speak to turn it back on."
line mic_hint       "I can't hear you yet. In Lens Studio, turn on the microphone in the Preview panel."
line mic_back       "I can hear you now."
