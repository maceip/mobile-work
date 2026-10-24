type Sum = (left: number, right: number) => number;
const refs = await sh.z_sig("src/math.ts");
await askCode<Sum>("Implement both exported functions using the caller contract and unchanged tests", refs);
await sh.z_verify("task-tests");
return "done";
