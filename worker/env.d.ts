declare module '*.wasm' { const module: WebAssembly.Module; export default module; }
declare module '*/binjgb.js' { const Binjgb: (opts?: object) => Promise<any>; export default Binjgb; }
