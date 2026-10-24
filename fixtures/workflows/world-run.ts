phase("check");
const found = await files.glob("src/**");
const r = await world.run("node", ["--test", "test/calc.test.mjs"]);
return { found, exitCode: r.exitCode };
