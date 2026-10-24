const refs = await sh.z_sig("src/math.ts");
const head = await sh.z_slice("src/math.ts", 1, 5);
await sh.z_verify("task-tests");
return { symbols: refs.map((r) => r.symbol), head };
