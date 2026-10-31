import { start } from './src.js';

start().catch(error => { console.error(error); process.exitCode = 1; });
