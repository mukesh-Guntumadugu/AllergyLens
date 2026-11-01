// AllergyLensAudio — the three sound cues (button click, scan reveal, detail pop).
// Owns: AudioComponents + volume. Expects: a host SceneObject from Main (runtime
// child, not an authored root). Must not react to events itself — Main calls it.

const CLICK = requireAsset("../GeneratedSFX/ButtonClick.wav") as AudioTrackAsset
const SCAN = requireAsset("../GeneratedSFX/ScanReveal.wav") as AudioTrackAsset
const POP = requireAsset("../GeneratedSFX/DetailPop.wav") as AudioTrackAsset

export class AllergyLensAudio {
  private click: AudioComponent
  private scan: AudioComponent
  private pop: AudioComponent

  constructor(host: SceneObject, volume: number) {
    this.click = this.make(host, CLICK, volume)
    this.scan = this.make(host, SCAN, volume)
    this.pop = this.make(host, POP, volume)
  }

  playClick(): void {
    this.click.play(1)
  }

  playScan(): void {
    this.scan.play(1)
  }

  playPop(): void {
    this.pop.play(1)
  }

  private make(host: SceneObject, track: AudioTrackAsset, volume: number): AudioComponent {
    const a = host.createComponent("Component.AudioComponent") as AudioComponent
    a.audioTrack = track
    a.volume = volume
    // Input-reactive cues: LowLatency so the sound lands on the pinch, not after it.
    a.playbackMode = Audio.PlaybackMode.LowLatency
    return a
  }
}
