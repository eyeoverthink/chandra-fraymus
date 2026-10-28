// Runtime construction can recover/interupt durable work. It must happen only
// after this process owns its listening socket, never before an EADDRINUSE check.
export function listenThenInitialize(server,{host,port,initialize}) {
  return new Promise((resolve,reject)=>{
    const failed=error=>reject(error);
    server.once('error',failed);
    server.listen(port,host,async()=>{
      server.off('error',failed);
      try { resolve(await initialize()); }
      catch(error) {
        // Do not hide an initialization failure behind an open HTTP/WS client.
        // The owner receives it immediately and drains its runtime and sockets.
        try { server.close(); } catch {}
        reject(error);
      }
    });
  });
}
