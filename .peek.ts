import { loadBank } from './src/server/content.js';
const b = loadBank('content');
for (const cat of process.argv.slice(2)) {
  const qs = b.questions.filter((q) => q.category === cat && q.audience === '35-75');
  console.log(`\n### ${cat} (${qs.length})`);
  for (const q of qs) console.log(`${q.prompt}  >> ${q.choices?.[q.answerIndex ?? 0]}`);
}
