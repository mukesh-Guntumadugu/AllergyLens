import {scenariosIndex} from "Leaf.lspkg/Scenarios/decorator/ScenarioIndexDecorator"
import {ScenarioMetadata} from "Leaf.lspkg/Scenarios/scenario/ScenarioMetadata"
import {AllergyLensLeafScenario1Profile} from "./AllergyLensLeafScenario1Profile"
import {AllergyLensLeafScenario2PeanutScan} from "./AllergyLensLeafScenario2PeanutScan"
import {AllergyLensLeafScenario3BeefRescan} from "./AllergyLensLeafScenario3BeefRescan"
import {AllergyLensLeafScenario4DishDetail} from "./AllergyLensLeafScenario4DishDetail"
import {AllergyLensLeafScenario5WorldLocked} from "./AllergyLensLeafScenario5WorldLocked"
import {AllergyLensLeafScenarioIKReach} from "./AllergyLensLeafScenarioIKReach"

@component
export class LeafIndex extends BaseScriptComponent {
  @scenariosIndex
  static scenariosIndex: ScenarioMetadata[] = [
    {id: "allergylens-1-profile-done", typename: AllergyLensLeafScenario1Profile.getTypeName()},
    {id: "allergylens-2-peanut-scan", typename: AllergyLensLeafScenario2PeanutScan.getTypeName()},
    {id: "allergylens-3-beef-rescan", typename: AllergyLensLeafScenario3BeefRescan.getTypeName()},
    {id: "allergylens-4-dish-detail", typename: AllergyLensLeafScenario4DishDetail.getTypeName()},
    {id: "allergylens-5-world-locked", typename: AllergyLensLeafScenario5WorldLocked.getTypeName()},
    {id: "allergylens-ik-reach-scan", typename: AllergyLensLeafScenarioIKReach.getTypeName()},
  ]
}
