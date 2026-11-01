
// media_creation_mega.wasm.js - One huge WASM bundle
// WASM memory + JS glue for web+image+video
class WASMMediaMemory {
  constructor(){this.memory=new WebAssembly.Memory({initial:1024,maximum:16384});this.heapU8=new Uint8Array(this.memory.buffer);this.width=3840;this.height=2160;}
  alloc_frame(w,h){this.width=w;this.height=h;const bytes=w*h*4;if(this.heapU8.length<bytes){const p=Math.ceil((bytes-this.heapU8.length)/65536);this.memory.grow(p);this.heapU8=new Uint8Array(this.memory.buffer);}return 0;}
}
self.MediaMegaWASM={memory:new WASMMediaMemory(),version:()=>100};
