import {createServer} from 'node:http';
import {readFile,stat} from 'node:fs/promises';
import {extname,join,normalize,resolve} from 'node:path';
const root=resolve('dist');
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.ico':'image/x-icon'};
const port=Number(process.env.PORT||3000);
createServer(async(req,res)=>{
  const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
  const path=resolve(root,'.'+normalize(pathname));
  if(!path.startsWith(root+'/')&&path!==root){res.writeHead(403).end();return}
  try{
    let file=path;
    if(!(await stat(file).catch(()=>null))?.isFile())file=join(root,'index.html');
    const body=await readFile(file);
    res.writeHead(200,{'content-type':mime[extname(file)]||'application/octet-stream','cache-control':file.endsWith('index.html')?'no-cache':'public, max-age=31536000, immutable'}).end(body);
  }catch{res.writeHead(404).end('Not found')}
}).listen(port,'0.0.0.0',()=>console.log(`RealtyBooks AI listening on ${port}`));
