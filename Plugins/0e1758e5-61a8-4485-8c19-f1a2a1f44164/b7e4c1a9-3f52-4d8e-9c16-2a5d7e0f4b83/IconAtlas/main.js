// Icon Atlas — a Lens Studio panel plugin shipped inside the Icons package.
//
// Open it from Windows › Icon Atlas, press "Scan scene for used icons", then
// "Create atlas from used icons". Only the icons the scene actually references
// are packed, because icons that stay in Packages/ are not part of a Lens build
// while anything referenced from the scene is.

import PanelPlugin from 'LensStudio:PanelPlugin'
import * as Ui from 'LensStudio:Ui'

import { AtlasPanel } from './AtlasPanel.js'

export class IconAtlasPlugin extends PanelPlugin {
  static descriptor() {
    return {
      id: 'Com.Snap.IconAtlas',
      name: 'Icon Atlas',
      description: 'Pack the icons your scene actually uses into one optimised atlas.',
      dependencies: [Ui.IGui],
    }
  }

  constructor(pluginSystem, descriptor) {
    super(pluginSystem, descriptor)
    this.panel = null
    this.model = this.pluginSystem.findInterface(Editor.Model.IModel)
  }

  createWidget(parentWidget) {
    this.panel = new AtlasPanel(parentWidget, this.model)
    return this.panel.getWidget()
  }
}
