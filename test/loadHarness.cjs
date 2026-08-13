const Module = require('module');
const orig = Module._load;
class El { constructor(){this.children=[];this.style={};this.classList={add(){},remove(){},toggle(){}};}
  createDiv(){return new El()} createSpan(){return new El()} createEl(){return new El()}
  empty(){} addClass(){} removeClass(){} toggleClass(){} setText(){} setAttribute(){}
  createFragment(){return new El()} setCssProps(){} onClickEvent(){} appendText(){}
  querySelectorAll(){return []} getBoundingClientRect(){return {height:400}} addEventListener(){}
  appendChild(){} }
const stub = {
  Plugin: class { constructor(app){ this.app=app; this.manifest={}; }
    addSettingTab(tab){
      // Obsidian 1.13 immediately indexes the tab's declarative settings.
      const defs = tab.getSettingDefinitions();
      const walk = (items) => { for (const it of items ?? []) { if (it.control) tab.getControlValue(it.control.key); walk(it.items); } };
      walk(defs);
    } addCommand(){} addRibbonIcon(){} registerView(){} registerEvent(){}
    registerObsidianProtocolHandler(){} registerInterval(){} addStatusBarItem(){return new El()}
    loadData(){return Promise.resolve(null)} saveData(){return Promise.resolve()} },
  PluginSettingTab: class { constructor(app, plugin){ this.app=app; this.plugin=plugin; this.containerEl=new El(); } update(){} },
  ItemView: class { constructor(leaf){ this.leaf=leaf; this.contentEl=new El(); } registerEvent(){} },
  Modal: class { constructor(app){ this.app=app; this.contentEl=new El(); this.titleEl=new El(); this.modalEl=new El(); } },
  FuzzySuggestModal: class { constructor(app){ this.app=app; } setPlaceholder(){} },
  Setting: class { constructor(){ this.controlEl=new El(); } setName(){return this} setDesc(){return this}
    setHeading(){return this} addText(){return this} addButton(){return this} addDropdown(){return this}
    addToggle(){return this} addTextArea(){return this} addExtraButton(){return this} },
  Notice: class {}, FileSystemAdapter: class { getBasePath(){ return '/tmp/harness-vault' } },
  TFile: class {}, TFolder: class {}, setIcon(){}, requestUrl(){}, normalizePath(p){return p},
};
Module._load = function(req, ...rest){ if (req === 'obsidian') return stub; return orig.call(this, req, ...rest); };
global.window = { setInterval: () => 1, clearInterval(){}, setTimeout: (f)=>{ return 1 }, clearTimeout(){}, open(){}, localStorage: { getItem(){return null}, setItem(){} } };
global.document = { createElement: () => new El() };
const fs = require('fs');
fs.mkdirSync('/tmp/harness-vault/.covault', {recursive:true});
const Plugin = require(require('path').join(__dirname, '..', 'main.js')).default;
const adapter = new stub.FileSystemAdapter();
const app = {
  vault: { adapter, configDir: '.obsidian', on(){}, getAbstractFileByPath(){return null}, getAllLoadedFiles(){return []} },
  workspace: { on(){}, onLayoutReady(cb){cb()}, getLeavesOfType(){return []}, getRightLeaf(){return null},
               getActiveFile(){return null}, revealLeaf(){return Promise.resolve()} },
  loadLocalStorage(){return null}, saveLocalStorage(){},
};
const p = new Plugin(app);
p.onload()
  .then(() => { console.log('ONLOAD OK'); })
  .catch((e) => { console.error('ONLOAD FAILED:', (e && e.stack) || e); process.exit(1); });
