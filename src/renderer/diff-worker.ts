import {compareText} from './diff-engine';
self.onmessage=(event:MessageEvent<{left:string;right:string}>)=>{
 try{self.postMessage({result:compareText(event.data.left,event.data.right)});}
 catch(error){self.postMessage({error:error instanceof Error?error.message:String(error)});}
};
