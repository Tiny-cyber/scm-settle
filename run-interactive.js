const readline = require('readline');
const { execSync } = require('child_process');

const yesterday = new Date();
yesterday.setDate(yesterday.getDate() - 1);
const ymd = yesterday.toISOString().slice(0, 10);

console.log('==============================');
console.log('  SCM 一键结算');
console.log('==============================');
console.log('');
console.log(`请输入要结算的日期（直接回车默认昨天 ${ymd}）：`);
console.log('  格式: 2026-03-19           （单日）');
console.log('        2026-03              （整月）');
console.log('        2026-03-19 2026-04-03（日期范围）');
console.log('');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question('> ', (answer) => {
  rl.close();
  console.log('');
  const input = answer.trim() || ymd;
  console.log('开始结算: ' + input);
  console.log('');
  try {
    execSync(`node settle-all.js ${input}`, { stdio: 'inherit' });
  } catch (e) {
    // settle-all.js already prints its own errors
  }
});
