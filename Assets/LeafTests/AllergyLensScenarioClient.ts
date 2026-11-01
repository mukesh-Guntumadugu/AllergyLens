// AllergyLensScenarioClient — runs every registered LEAF scenario in the preview,
// one after another, and prints a PASSED / FAILED line per scenario plus a summary.
// Off by default (autoRun = false) so the demo Lens is never driven by tests.
import {DefaultScenarioManager} from "Leaf.lspkg/Scenarios/scenario/manager/DefaultLeafScenarioManager"
import {sleep} from "Leaf.lspkg/Utils/common/Utils"

@component
export class AllergyLensScenarioClient extends BaseScriptComponent {
  @input
  @hint("Run all LEAF scenarios automatically when the Lens starts (testing only).")
  autoRun: boolean = false

  onAwake() {
    if (!this.autoRun) return
    this.runScenarios()
      .then((summary) => print(`[LEAF SUMMARY] ${summary}`))
      .catch((error) => print(`[LEAF SUMMARY] runner crashed: ${error}`))
  }

  private async runScenarios(): Promise<string> {
    const manager = DefaultScenarioManager.getInstance()
    await sleep(2000)
    const ids = manager.listScenarioIds()
    let passed = 0
    const failed: string[] = []
    for (const id of ids) {
      await sleep(800)
      try {
        await manager.startScenario(id)
        print(`[LEAF] ${id}: PASSED`)
        passed++
      } catch (e) {
        print(`[LEAF] ${id}: FAILED ${e}`)
        failed.push(id)
      }
    }
    return `${passed}/${ids.length} passed; failed: [${failed.join(", ")}]`
  }
}
