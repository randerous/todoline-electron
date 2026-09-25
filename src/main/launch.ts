import path from 'node:path';
import {isDocumentPath} from '../shared/native-document';

export function launchRequest(argv:string[],cwd:string,defaultApp:boolean){
  const files:string[]=[],seen=new Set<string>();let quit=false,literal=false;
  const add=(value:string)=>{if(!value||value.includes('\0')||!isDocumentPath(value))return;const file=path.resolve(cwd,value),key=file.toLowerCase();if(!seen.has(key)){seen.add(key);files.push(file);}};
  const args=argv.slice(defaultApp?2:1);
  for(let i=0;i<args.length;i++){
    const arg=args[i];
    if(literal){add(arg);continue;}
    if(arg==='--'){literal=true;continue;}
    if(arg==='--quit'){quit=true;continue;}
    if(arg==='--open'){if(args[i+1]&&!args[i+1].startsWith('--'))add(args[++i]);continue;}
    if(arg.startsWith('--open=')){add(arg.slice(7));continue;}
    if(!arg.startsWith('-'))add(arg);
  }
  return {files,quit};
}
