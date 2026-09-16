// A tiny SDK stand-in. Only user Runs should reach it; the cwd and arguments
// provide evidence without requiring JBang, a JVM, or real code generation.
import * as fs from 'node:fs';

const output = 'sdk-invocations.json';
const invocations = fs.existsSync(output) ? JSON.parse(fs.readFileSync(output, 'utf8')) : [];
invocations.push(process.argv.slice(2));
fs.writeFileSync(output, JSON.stringify(invocations));
