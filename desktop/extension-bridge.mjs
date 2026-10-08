import {randomUUID} from 'node:crypto';
import {createEventBus} from './pi-core.mjs';

/** Desktop implementation of Pi's portable extension UI contract. */
export class ExtensionBridge {
  constructor(emit, onChange = () => {}) {
    this.emit = emit; this.onChange = onChange; this.events = createEventBus();
    this.statuses = new Map(); this.widgets = new Map(); this.cards = new Map(); this.dialogs = new Map();
    this.events.on('workbench:workflow', value => {
      if (!value || typeof value.id !== 'string' || !['plan','goal'].includes(value.id)) return;
      if (value.removed) this.cards.delete(value.id); else this.cards.set(value.id, structuredClone(value));
      this.update();
    });
  }
  get state() {return {statuses:Object.fromEntries(this.statuses),widgets:Object.fromEntries(this.widgets),cards:[...this.cards.values()],dialogs:[...this.dialogs.values()].map(d=>d.request)};}
  update() {this.onChange(this.state);this.emit({type:'extension_state',extensionUI:this.state});}
  request(method, data, options = {}) {
    if(this.disposed) return Promise.resolve(method === 'confirm' ? false : undefined);
    const id = randomUUID(), request = {id,method,...data};
    return new Promise(resolve => {
      const finish = value => {const d=this.dialogs.get(id);if(!d)return;clearTimeout(d.timer);options.signal?.removeEventListener('abort',cancel);this.dialogs.delete(id);resolve(value);this.emit({type:'extension_ui_closed',id});this.update();};
      const cancel = () => finish(method === 'confirm' ? false : undefined);
      const timer = options.timeout > 0 ? setTimeout(cancel,options.timeout) : undefined;
      this.dialogs.set(id,{request,finish,timer});options.signal?.addEventListener('abort',cancel,{once:true});
      if(options.signal?.aborted) {cancel();return;}
      this.emit({type:'extension_ui_request',request});this.update();
    });
  }
  respond({id,value,confirmed,cancelled} = {}) {
    const dialog=this.dialogs.get(id);if(!dialog) throw new Error('此交互已经结束，请重新执行指令');
    const {method,options}=dialog.request;
    if(cancelled) dialog.finish(method==='confirm'?false:undefined);
    else if(method==='confirm') {if(typeof confirmed!=='boolean')throw new Error('请选择确认或取消');dialog.finish(confirmed);}
    else {if(typeof value!=='string' || Buffer.byteLength(value)>256*1024 || (method==='select' && !options.includes(value)))throw new Error('无效插件交互内容');dialog.finish(value);}
  }
  cancel() {for(const d of [...this.dialogs.values()]) d.finish(d.request.method==='confirm'?false:undefined);}
  dispose() {this.cancel();this.disposed=true;this.events.clear();this.statuses.clear();this.widgets.clear();this.cards.clear();}
  ui({autocomplete,setEditorText}) {
    const noop=()=>{};
    return {
      select:(title,options,opts)=>this.request('select',{title:String(title),options:options.map(String)},opts),
      confirm:(title,message,opts)=>this.request('confirm',{title:String(title),message:String(message)},opts),
      input:(title,placeholder,opts)=>this.request('input',{title:String(title),placeholder:String(placeholder || '')},opts),
      editor:(title,prefill)=>this.request('editor',{title:String(title),prefill:String(prefill || '')}),
      notify:(message,level='info')=>this.emit({type:'extension_notice',message:String(message),level}),
      setStatus:(key,value)=>{value===undefined || value==='' ? this.statuses.delete(key) : this.statuses.set(key,String(value));this.update();},
      setWidget:(key,content,options)=>{if(content===undefined)this.widgets.delete(key);else if(Array.isArray(content))this.widgets.set(key,{lines:content.map(String),placement:options?.placement || 'aboveEditor'});else return;this.update();},
      addAutocompleteProvider:autocomplete,setEditorText,
      pasteToEditor:setEditorText,getEditorText:()=>'',getEditorComponent:()=>undefined,
      custom:async()=>undefined,onTerminalInput:()=>noop,getAllThemes:()=>[],getTheme:()=>undefined,
      theme:{fg:(_color,text)=>text,bg:(_color,text)=>text,bold:text=>text,italic:text=>text},
      setTheme:()=>({success:false,error:'终端主题不影响桌面外观'}),getToolsExpanded:()=>false,
      setWorkingMessage:noop,setWorkingVisible:noop,setWorkingIndicator:noop,setHiddenThinkingLabel:noop,
      setTitle:noop,setFooter:noop,setHeader:noop,setEditorComponent:noop,setToolsExpanded:noop,
    };
  }
}
