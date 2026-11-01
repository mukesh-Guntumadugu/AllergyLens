import {scenariosIndex} from "Leaf.lspkg/Scenarios/decorator/ScenarioIndexDecorator"
import {ScenarioMetadata} from "Leaf.lspkg/Scenarios/scenario/ScenarioMetadata"
import {AllergyLensLeafScenario1Profile} from "./AllergyLensLeafScenario1Profile"
import {AllergyLensLeafScenario2StarPeanutMilk} from "./AllergyLensLeafScenario2StarPeanutMilk"
import {AllergyLensLeafScenario3ChoiceRule} from "./AllergyLensLeafScenario3ChoiceRule"
import {AllergyLensLeafScenario4DetailOnPinch} from "./AllergyLensLeafScenario4DetailOnPinch"
import {AllergyLensLeafScenario5MarkerLost} from "./AllergyLensLeafScenario5MarkerLost"
import {AllergyLensLeafScenario6MoodVegetarian} from "./AllergyLensLeafScenario6MoodVegetarian"
import {AllergyLensLeafScenario7MoodChicken} from "./AllergyLensLeafScenario7MoodChicken"
import {AllergyLensLeafScenario8EverythingLight} from "./AllergyLensLeafScenario8EverythingLight"
import {AllergyLensLeafScenario9VoiceMatch} from "./AllergyLensLeafScenario9VoiceMatch"

@component
export class LeafIndex extends BaseScriptComponent {
  @scenariosIndex
  static scenariosIndex: ScenarioMetadata[] = [
    {id: "allergylens-1-profile-done", typename: AllergyLensLeafScenario1Profile.getTypeName()},
    {id: "allergylens-2-star-peanut-milk", typename: AllergyLensLeafScenario2StarPeanutMilk.getTypeName()},
    {id: "allergylens-3-choice-rule", typename: AllergyLensLeafScenario3ChoiceRule.getTypeName()},
    {id: "allergylens-4-detail-on-pinch", typename: AllergyLensLeafScenario4DetailOnPinch.getTypeName()},
    {id: "allergylens-5-marker-lost", typename: AllergyLensLeafScenario5MarkerLost.getTypeName()},
    {id: "allergylens-6-mood-vegetarian", typename: AllergyLensLeafScenario6MoodVegetarian.getTypeName()},
    {id: "allergylens-7-mood-chicken", typename: AllergyLensLeafScenario7MoodChicken.getTypeName()},
    {id: "allergylens-8-everything-light", typename: AllergyLensLeafScenario8EverythingLight.getTypeName()},
    {id: "allergylens-9-voice-match", typename: AllergyLensLeafScenario9VoiceMatch.getTypeName()},
  ]
}
