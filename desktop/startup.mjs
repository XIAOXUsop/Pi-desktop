// Timings contain stage names and durations only, never settings or message text.
export class StartupTrace {
  constructor() { this.stages = []; this.finished = new Promise(resolve => { this.finish = resolve; }); }
  mark(stage) {
    if (this.stages.some(item => item.stage === stage)) return;
    this.stages.push({stage,milliseconds:Math.round(process.uptime()*1000)});
    if (stage === 'renderer-ready') this.finish();
  }
  snapshot() { return this.stages.map((item,index)=>({...item,duration:item.milliseconds-(this.stages[index-1]?.milliseconds || 0)})); }
}
export const startup = new StartupTrace();
startup.mark('imports-start');
