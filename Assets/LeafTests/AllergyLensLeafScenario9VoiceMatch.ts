// voice-match (pure): the fuzzy dish-name matcher used by the voice path.
import {Scenario} from "Leaf.lspkg/Scenarios/scenario/Scenario"
import {expect} from "Leaf.lspkg/Utils/common/Expect"
import {matchDishByVoice} from "../Scripts/AllergyLensVoice"
import {LAUREL} from "./AllergyLensLeafInteractor"

@component
export class AllergyLensLeafScenario9VoiceMatch extends Scenario {
  async run(): Promise<void> {
    const d = LAUREL.dishes
    expect(matchDishByVoice("flat white", d)?.id, "flat white").toBe("flat-white")
    expect(matchDishByVoice("a cappuccino please", d)?.id, "a cappuccino please").toBe("cappuccino")
    expect(matchDishByVoice("I'd like the Chocolate Brownie.", d)?.id, "sentence containing the name").toBe("chocolate-brownie")
    expect(matchDishByVoice("pizza", d), "pizza is not on this page").toBeNull()
    expect(matchDishByVoice("", d), "empty transcript").toBeNull()
  }
}
