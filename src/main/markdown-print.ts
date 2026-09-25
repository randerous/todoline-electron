import fs from 'node:fs/promises';
import path from 'node:path';

let cached:Promise<string>|undefined;
/** Inline the bundled KaTeX stylesheet/fonts for a fully offline print window. */
export function markdownPrintStyles(assets:string):Promise<string>{
  return cached??=(async()=>{
    const filename=(await fs.readdir(assets)).find(name=>/^katex-.*\.css$/.test(name));
    if(!filename)throw new Error('未找到本地公式打印样式，请重新构建应用。');
    let css=await fs.readFile(path.join(assets,filename),'utf8');
    const urls=[...new Set(Array.from(css.matchAll(/url\(([^)]+)\)/g),match=>match[1]))];
    for(const value of urls){
      if(/^['"]?data:(?:font\/[\w-]+|application\/font-woff);base64,/i.test(value))continue;
      const name=path.basename(value.replace(/^['"]|['"]$/g,''));
      if(!/^KaTeX_[\w-]+\.(woff2?|ttf)$/.test(name))throw new Error('无效公式字体资源。');
      const bytes=await fs.readFile(path.join(assets,name)),mime=name.endsWith('.woff2')?'font/woff2':name.endsWith('.woff')?'font/woff':'font/ttf';
      css=css.replaceAll(`url(${value})`,`url(data:${mime};base64,${bytes.toString('base64')})`);
    }
    return css+'\nbody h1{font-size:20pt}body h2{font-size:16pt;text-align:left;border:0;padding:0;color:inherit}body h3{font-size:13pt}body table{border-collapse:collapse;width:auto;max-width:100%}body td,body th{border:1px solid #b8bec8;padding:5px 8px}body .katex-display{margin:1em 0}';
  })().catch(error=>{cached=undefined;throw error;});
}
