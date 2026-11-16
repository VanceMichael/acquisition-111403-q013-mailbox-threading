import {createServer} from 'node:http';
import {openArchive} from './archive.mjs';
import {createClient} from './source.mjs';
import {collect} from './reader.mjs';
import {ingestArchives} from './ingest.mjs';
import {buildThreads} from './thread.mjs';

export async function startIntake({origin,directory,port=0}) {
  const archive=await openArchive(directory);
  const server=createServer(async (request,response)=>{
    const send=(value,status=200)=>{response.writeHead(status,{'content-type':'application/json; charset=utf-8'});response.end(JSON.stringify(value));};
    try {
      const url=new URL(request.url,'http://localhost');
      const path=url.pathname;
      if(request.method==='GET'&&path==='/health'){send({status:'运行中'});return;}
      if(request.method==='GET'&&path==='/records'){send(archive.records());return;}
      if(request.method==='GET'&&path==='/receipts'){send(archive.exchanges());return;}
      if(request.method==='POST'&&path==='/collect'){
        const client=createClient(origin);const records=await collect(client);
        send(await archive.commit(records,client.exchanges));return;
      }
      if(request.method==='POST'&&path==='/ingest'){
        const client=createClient(origin);
        send(await ingestArchives(client,archive));return;
      }
      if(request.method==='GET'&&path==='/threads'){send(buildThreads(archive.records()));return;}
      if(request.method==='GET'&&path==='/quarantine'){send(archive.quarantine());return;}
      if(request.method==='GET'&&path==='/archives'){send(archive.archives());return;}
      if(request.method==='GET'&&path.startsWith('/raw/')){
        const bytes=await archive.rawSlice(path.slice(5),url.searchParams.get('offset')??0,url.searchParams.get('length'));
        response.writeHead(200,{'content-type':'application/octet-stream'});response.end(bytes);return;
      }
      send({message:'接口不存在'},404);
    } catch(error){send({message:error.message},502);}
  });
  await new Promise(resolve=>server.listen(port,'0.0.0.0',resolve));
  return {origin:`http://127.0.0.1:${server.address().port}`,archive,close:()=>new Promise(resolve=>server.close(resolve))};
}
