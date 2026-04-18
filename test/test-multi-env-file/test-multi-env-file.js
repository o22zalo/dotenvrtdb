// test-multi-env-file.js
console.log("KEY1 =", process.env.KEY1 ?? "(undefined)");
console.log("KEY2 =", process.env.KEY2 ?? "(undefined)");
console.log("SHARED =", process.env.SHARED ?? "(undefined)");
console.log("FROM_SHELL =", process.env.FROM_SHELL ?? "(undefined)");

console.log(
  JSON.stringify(
    {
      KEY1: process.env.KEY1,
      KEY2: process.env.KEY2,
      SHARED: process.env.SHARED,
      FROM_SHELL: process.env.FROM_SHELL,
    },
    null,
    2,
  ),
);
