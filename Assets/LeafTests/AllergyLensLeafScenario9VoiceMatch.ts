// voice-match (pure): the fuzzy dish-name matcher used by the voice path.
import {Scenario} from "Leaf.lspkg/Scenarios/scenario/Scenario"
import {expect} from "Leaf.lspkg/Utils/common/Expect"
import {matchDishByVoice} from "../Scripts/AllergyLensVoice"
import {STAR} from "./AllergyLensLeafInteractor"

@component
export class AllergyLensLeafScenario9VoiceMatch extends Scenario {
  async run(): Promise<void> {
    const d = STAR.dishes
    expect(matchDishByVoice("mixed naan", d)?.id, "mixed naan").toBe("mixed-nan")
    expect(matchDishByVoice("garlic nan please", d)?.id, "garlic nan please").toBe("garlic-nan")
    expect(matchDishByVoice("I'd like the Gulab Jamun.", d)?.id, "sentence containing the name").toBe("gulab-jamun")
    expect(matchDishByVoice("pizza", d), "pizza is not on this page").toBeNull()
    expect(matchDishByVoice("", d), "empty transcript").toBeNull()
  }
}
