interface Answer { value: number }
const refs = await sh.z_sig("src/math.ts");
const answer = await askData<Answer>("Return the expected result of sum(20, 22) as data", refs);
await sh.z_verify("task-tests");
return answer;
