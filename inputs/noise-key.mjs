import {readFileSync} from 'node:fs';
const data = JSON.parse(readFileSync(new URL('./noise-key.json', import.meta.url), 'utf8'));
import {createHash} from 'node:crypto';

export function noiseRow(index, basis) {
  const {grid,rank}=data;
  const cells=grid[0]*grid[1]*grid[2];
  if(index<0||index>=cells) throw new RangeError('网格坐标越界');
  const phase=basis==='basis1'?0:.25;
  const scale=index%257===0?0:0.125*(1+(index%13)/13);
  return {d:scale,u:Float64Array.from({length:rank},(_,i)=>Math.sin(index*.1047+i*.391+phase)*.03125)};
}
export function noiseNormal(step, component, index) {
  const hash=createHash('sha256').update(JSON.stringify([data.seed,step,component,index])).digest();
  const u=(hash.readUInt32BE(0)+.5)/4294967296, v=(hash.readUInt32BE(4)+.5)/4294967296;
  return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v);
}
export function conditionTile(tile) {
  return Array.from({length:data.tileConditions},(_,i)=>{
    const j=(tile*data.tileConditions+i)*8;
    return [`P${tile}-${i}`,[j,j+1,j+3,j+5],[.25, .25, .25, .25],Math.sin(j*.03)*.21];
  });
}
